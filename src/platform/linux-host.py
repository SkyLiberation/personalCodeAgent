"""Linux ownership bridge. Target programs cannot pass their gate before journal fsync."""
import ctypes
import fcntl
import json
import os
import selectors
import signal
import subprocess
import sys
import threading
import time

if len(sys.argv) > 1 and sys.argv[1] == "--child":
    gate = int(sys.argv[2])
    allowed = os.read(gate, 1) == b"1"
    os.close(gate)
    if allowed:
        os.execvpe(sys.argv[3], sys.argv[3:], os.environ)
    sys.exit(0)

# Reap descendants after their original parent exits, including during bridge EOF.
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
    raise OSError(ctypes.get_errno(), "subreaper unavailable")

leases = {}
groups = {}
output_lock = threading.Lock()
groups_lock = threading.Lock()
quarantined = False
with open("/proc/sys/kernel/random/boot_id") as boot_file:
    boot_id = boot_file.read().strip()
pid_namespace = os.readlink("/proc/self/ns/pid")


def validate_source(request):
    if request.get("bootId") != boot_id or request.get("pidNamespace") != pid_namespace:
        raise RuntimeError("process_state_unknown: execution provenance mismatch")


def stat(pid):
    try:
        with open(f"/proc/{pid}/stat") as file:
            fields = file.read().rsplit(")", 1)[1].split()
        return {"state": fields[0], "group": int(fields[2]), "starttime": fields[19]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def members(group):
    found = []
    for name in os.listdir("/proc"):
        if name.isdigit():
            info = stat(int(name))
            if info and info["group"] == group:
                found.append((int(name), info["state"]))
    return found


def stop_group(group):
    # Include zombies in reaping, but they no longer execute effects.
    if members(group):
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while True:
        found = members(group)
        for pid, state in found:
            # Popen must reap its own leader and retain the actual exit status.
            # Reaping it here can turn SIGKILL into a spurious exitCode=0.
            if state == "Z" and pid != group:
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
        if not any(state != "Z" for _, state in found):
            return
        if time.monotonic() > deadline:
            raise RuntimeError("process_state_unknown: process group did not stop")
        time.sleep(0.01)


def stop(group):
    global quarantined
    try:
        stop_group(group)
    except Exception:
        # Control-lock admission also fails: no model or file tool may continue
        # while an old process effect cannot be confirmed stopped.
        quarantined = True
        raise


def reply(request_id, result=None, error=None):
    with output_lock:
        print(json.dumps({"id": request_id, "result": result, "error": error}), flush=True)


def collect(request_id, entry):
    global quarantined
    process = entry["process"]
    stdout, stderr = bytearray(), bytearray()
    selector = selectors.DefaultSelector()
    completed = False
    for pipe, buffer in ((process.stdout, stdout), (process.stderr, stderr)):
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ, buffer)
    try:
        while selector.get_map():
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                elif len(key.data) < 1_000_000:
                    key.data.extend(chunk[:1_000_000 - len(key.data)])
            if process.poll() is not None:
                # A normally exited leader may leave children holding output pipes.
                stop(process.pid)
        code = process.wait()
        stop(process.pid)
        reply(request_id, {"stdout": stdout.decode("utf-8", "replace"),
                           "stderr": stderr.decode("utf-8", "replace"), "exitCode": code})
        completed = True
    except Exception as error:
        quarantined = True
        reply(request_id, error=str(error))
    finally:
        selector.close()
        with groups_lock:
            if completed:
                groups.pop(request_id, None)


try:
    reply("ready", {"pid": os.getpid()})
    for line in sys.stdin:
        request = json.loads(line)
        request_id, action = request["id"], request["action"]
        try:
            if quarantined and action in ("acquire", "prepare", "start"):
                raise RuntimeError("process_state_unknown: bridge quarantined after cleanup failure")
            if action == "acquire":
                path = request["path"]
                os.makedirs(os.path.dirname(path), exist_ok=True)
                file = open(path, "a+b")
                try:
                    fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    file.close()
                    raise RuntimeError("execution_busy: lease held")
                leases[request_id] = file
                reply(request_id, True)
            elif action == "release":
                leases.pop(request["lease"]).close()
                reply(request_id, True)
            elif action == "prepare":
                read_gate, write_gate = os.pipe()
                try:
                    process = subprocess.Popen(
                        [sys.executable, "-u", __file__, "--child", str(read_gate),
                         request["executable"], *request["args"]],
                        cwd=request["cwd"], start_new_session=True,
                        pass_fds=(read_gate,), stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                except Exception:
                    os.close(write_gate)
                    raise
                finally:
                    os.close(read_gate)
                entry = {"process": process, "gate": write_gate}
                with groups_lock:
                    groups[request_id] = entry
                identity = stat(process.pid)
                if not identity:
                    raise RuntimeError("process_state_unknown: prepared child vanished")
                reply(request_id, {"pid": process.pid, "starttime": identity["starttime"], "bootId": boot_id, "pidNamespace": pid_namespace})
            elif action == "start":
                operation = request["operation"]
                entry = groups[operation]
                os.write(entry["gate"], b"1")
                os.close(entry.pop("gate"))
                threading.Thread(target=collect, args=(request_id, entry), daemon=True).start()
            elif action == "abort":
                with groups_lock:
                    entry = groups.get(request["operation"])
                if entry:
                    stop(entry["process"].pid)
                    if "gate" in entry:
                        os.close(entry.pop("gate"))
                        entry["process"].wait()
                        with groups_lock:
                            groups.pop(request["operation"], None)
                reply(request_id, True)
            elif action == "validate_source":
                validate_source(request)
                reply(request_id, True)
            elif action == "quiesce":
                validate_source(request)
                pid = request["pid"]
                live = [(member, state) for member, state in members(pid) if state != "Z"]
                if live:
                    identity = stat(pid)
                    if not identity or identity["starttime"] != request["starttime"]:
                        raise RuntimeError("process_state_unknown: live group identity unconfirmed")
                    stop(pid)
                reply(request_id, True)
            else:
                raise RuntimeError("unknown action")
        except Exception as error:
            reply(request_id, error=str(error))
finally:
    # EOF after the Node owner exits: effects must cease before flock descriptors close.
    with groups_lock:
        remaining = list(groups.values())
    for entry in remaining:
        if "gate" in entry:
            os.close(entry.pop("gate"))
        stop(entry["process"].pid)
        entry["process"].wait()
    for file in leases.values():
        file.close()
