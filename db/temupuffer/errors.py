"""API errors. Each one maps to an HTTP status code in the server."""


class ApiError(Exception):
    status = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class BadRequest(ApiError):
    status = 400


class NamespaceNotFound(ApiError):
    status = 404


class Conflict(ApiError):
    status = 409


class Backpressure(ApiError):
    """Write docs: writes get 429 when unindexed data passes 2 GB or 1M rows."""

    status = 429
