export class DomainError extends Error {
  status = 422;
}

export class ConflictError extends DomainError {
  status = 409;
}

export class NotFoundError extends DomainError {
  status = 404;
}
