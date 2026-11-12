export class ApplicationError<Code extends string = string> extends Error {
  readonly code: Code;

  constructor(code: Code, message: string = code) {
    super(message);
    this.code = code;
  }
}

export class HttpError<Code extends string = string> extends ApplicationError<Code> {
  readonly status: number;

  constructor(status: number, code: Code, message: string = code) {
    super(code, message);
    this.status = status;
  }
}
