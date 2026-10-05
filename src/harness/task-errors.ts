/** A condition the host can repair before explicitly resuming the same task. */
export class TaskBlockedError extends Error {
  constructor(readonly code: "effect_unknown" | "verification_inputs_changed" | "verification_unavailable" | "no_progress" | "required_input", detail: string, options?: ErrorOptions) {
    super(`${code}：${detail}`, options);
    this.name = "TaskBlockedError";
  }
}
