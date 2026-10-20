export class ActionError extends Error {}

/** Petición mal formada por el usuario (la API responde 400). */
export class BadRequestError extends Error {}

/** El que pide no puede hacer ese cambio (la API responde 403 con el motivo). */
export class ForbiddenError extends Error {}
