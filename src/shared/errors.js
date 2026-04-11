export class BusinessError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
    this.isBusinessError = true;
  }
}
