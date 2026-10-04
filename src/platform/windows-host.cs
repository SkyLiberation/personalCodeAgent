// A private Win32 bridge. Handles never leave this process. stdin EOF stops all
// jobs before releasing leases; bridge death invokes KILL_ON_JOB_CLOSE in kernel.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class WindowsHost {
  [StructLayout(LayoutKind.Sequential)] struct Overlapped { public IntPtr Internal, InternalHigh; public uint Offset, OffsetHigh; public IntPtr Event; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public short Show,ReservedSize; public IntPtr ReservedPointer,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadCount,WriteCount,OtherCount,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool LockFileEx(IntPtr f,uint flags,uint reserved,uint low,uint high,ref Overlapped o);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UnlockFileEx(IntPtr f,uint reserved,uint low,uint high,ref Overlapped o);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref ExtendedLimit l,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,ref Accounting a,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup s,out ProcessInfo p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security s,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
  static readonly object Gate=new object(), PrintGate=new object();
  static readonly Dictionary<string,FileStream> Leases=new Dictionary<string,FileStream>();
  static readonly Dictionary<string,IntPtr> Jobs=new Dictionary<string,IntPtr>();
  static readonly HashSet<string> Cancelled=new HashSet<string>();
  static bool Closing;
  static string Get(Dictionary<string,object> d,string k) { return Convert.ToString(d[k]); }
  static Exception Error(string operation) { return new Exception(operation+": win32="+Marshal.GetLastWin32Error()); }
  static void Print(object value) { lock(PrintGate) { Console.WriteLine(new JavaScriptSerializer { MaxJsonLength=16000000 }.Serialize(value)); Console.Out.Flush(); } }
  static string Quote(string s) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; }
    b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  static string ReadPipe(IntPtr h) { using(var stream=new FileStream(new SafeFileHandle(h,true),FileAccess.Read)) using(var reader=new StreamReader(stream,Encoding.UTF8)) { char[] buffer=new char[4096]; var text=new StringBuilder(); int n; while((n=reader.Read(buffer,0,buffer.Length))>0) { int room=1000000-text.Length; if(room>0) text.Append(buffer,0,Math.Min(room,n)); } return text.ToString(); } }
  static void Quiesce(IntPtr job) { TerminateJobObject(job,130); var a=new Accounting(); while(true) { if(!QueryInformationJobObject(job,1,ref a,(uint)Marshal.SizeOf(a),IntPtr.Zero)) throw Error("query job"); if(a.Active==0) return; Thread.Sleep(10); } }
  static object Run(Dictionary<string,object> d) {
    string id=Get(d,"id"); IntPtr job=IntPtr.Zero,readOut=IntPtr.Zero,writeOut=IntPtr.Zero,readErr=IntPtr.Zero,writeErr=IntPtr.Zero; var p=new ProcessInfo(); bool started=false,readers=false;
    lock(Gate) {
      if(Closing || Cancelled.Contains(id)) throw new Exception("host closing or operation cancelled");
      job=CreateJobObject(IntPtr.Zero,Get(d,"jobName")); if(job==IntPtr.Zero) throw Error("create job");
      var limits=new ExtendedLimit(); limits.Basic.Flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits))) { CloseHandle(job); throw Error("job limits"); }
      Jobs[id]=job;
    }
    try {
      var security=new Security { Length=Marshal.SizeOf(typeof(Security)),Inherit=1 };
      if(!CreatePipe(out readOut,out writeOut,ref security,0)||!CreatePipe(out readErr,out writeErr,ref security,0)) throw Error("pipes");
      SetHandleInformation(readOut,1,0); SetHandleInformation(readErr,1,0);
      var s=new Startup { Size=Marshal.SizeOf(typeof(Startup)),Flags=0x100,Output=writeOut,Error=writeErr,Input=IntPtr.Zero };
      var command=new StringBuilder(Quote(Get(d,"executable"))); foreach(object arg in (System.Collections.IEnumerable)d["args"]) command.Append(" ").Append(Quote(Convert.ToString(arg)));
      lock(Gate) {
        if(Closing || Cancelled.Contains(id)) throw new Exception("host closing or operation cancelled");
        if(!CreateProcess(Get(d,"executable"),command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,Get(d,"cwd"),ref s,out p)) throw Error("create process");
        started=true;
        if(!AssignProcessToJobObject(job,p.Process)) { TerminateProcess(p.Process,130); throw Error("assign job"); }
        if(ResumeThread(p.Thread)==0xffffffff) throw Error("resume process");
      }
      CloseHandle(writeOut);writeOut=IntPtr.Zero;CloseHandle(writeErr);writeErr=IntPtr.Zero;
      var stdout=Task.Factory.StartNew(()=>ReadPipe(readOut)); var stderr=Task.Factory.StartNew(()=>ReadPipe(readErr));
      readers=true;
      WaitForSingleObject(p.Process,0xffffffff); uint exit; GetExitCodeProcess(p.Process,out exit);
      Quiesce(job); // Also stop any child that outlived its foreground parent.
      return new { stdout=stdout.Result,stderr=stderr.Result,exitCode=(int)exit };
    } finally {
      if(writeOut!=IntPtr.Zero) CloseHandle(writeOut); if(writeErr!=IntPtr.Zero) CloseHandle(writeErr);
      if(!readers) { if(readOut!=IntPtr.Zero) CloseHandle(readOut);if(readErr!=IntPtr.Zero) CloseHandle(readErr); }
      if(started) { CloseHandle(p.Thread);CloseHandle(p.Process); }
      lock(Gate) { if(Jobs.Remove(id)) { Quiesce(job);CloseHandle(job); } }
    }
  }
  static object Dispatch(Dictionary<string,object> d) {
    string action=Get(d,"action"),id=Get(d,"id");
    if(action=="run") return Run(d);
    lock(Gate) {
      if(Closing) throw new Exception("host closing");
      if(action=="acquire") {
        string path=Get(d,"path"); Directory.CreateDirectory(Path.GetDirectoryName(path));
        var file=new FileStream(path,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.ReadWrite);
        var o=new Overlapped(); if(!LockFileEx(file.SafeFileHandle.DangerousGetHandle(),3,0,1,0,ref o)) { int code=Marshal.GetLastWin32Error();file.Dispose(); throw new Exception(code==33 ? "busy: execution lease held" : "ownership_backend_error: win32="+code); }
        Leases[id]=file;return new { lease=id };
      }
      if(action=="release") { string lease=Get(d,"lease");FileStream file; if(Leases.TryGetValue(lease,out file)) { var o=new Overlapped();UnlockFileEx(file.SafeFileHandle.DangerousGetHandle(),0,1,0,ref o);file.Dispose();Leases.Remove(lease); } return new { released=true }; }
      if(action=="abort") { string operation=Get(d,"operation");Cancelled.Add(operation);IntPtr job;if(Jobs.TryGetValue(operation,out job)) TerminateJobObject(job,130);return new { stopped=true }; }
      if(action=="quiesce") { IntPtr job=OpenJobObject(12,false,Get(d,"jobName"));if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()!=2) throw Error("open old job");return new { active=0 }; }try { Quiesce(job);return new { active=0 }; }finally { CloseHandle(job); } }
      throw new Exception("unknown action");
    }
  }
  static void Main() {
    Console.InputEncoding=Encoding.UTF8; Console.OutputEncoding=new UTF8Encoding(false);
    try {
      string line;
      while((line=Console.ReadLine())!=null) {
        var d=new JavaScriptSerializer { MaxJsonLength=16000000 }.Deserialize<Dictionary<string,object>>(line);
        Task.Factory.StartNew(()=> { string id=Get(d,"id");try { Print(new { id=id,result=Dispatch(d) }); } catch(Exception e) { Print(new { id=id,error=e.GetBaseException().Message }); } });
      }
    } finally {
      lock(Gate) { Closing=true;foreach(var job in Jobs.Values) { Quiesce(job);CloseHandle(job); } Jobs.Clear();foreach(var file in Leases.Values) file.Dispose();Leases.Clear(); }
    }
  }
}
