export class SecretRedactor {
  private readonly values: readonly string[];

  constructor(secrets: readonly string[] = []) {
    this.values = secrets.filter((secret) => secret.length > 0);
  }

  text(value: string): string {
    return this.values.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  }

  json<T>(value: T): T {
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }

  stream(): StreamingRedactor {
    return new StreamingRedactor(this.values);
  }
}

class StreamingRedactor {
  private pending = "";
  private readonly redactor: SecretRedactor;

  constructor(private readonly values: readonly string[]) {
    this.redactor = new SecretRedactor(values);
  }

  write(chunk: string): string {
    const text = this.redactor.text(this.pending + chunk);
    let keep = 0;
    for (const value of this.values) {
      for (let length = 1; length < value.length && length <= text.length; length++) {
        if (text.endsWith(value.slice(0, length))) keep = Math.max(keep, length);
      }
    }
    this.pending = keep > 0 ? text.slice(-keep) : "";
    return keep > 0 ? text.slice(0, -keep) : text;
  }

  end(): string {
    const value = this.pending.length > 4 ? "[REDACTED]" : this.pending;
    this.pending = "";
    return value;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function abortError(): Error {
  return new DOMException("操作已取消", "AbortError");
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
