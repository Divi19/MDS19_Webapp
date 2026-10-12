"""Errors predictors raise that routes.py maps to specific HTTP statuses."""


class TissueNotSupportedError(Exception):
    """
    The multi-cancer tissue router decided the slide is not a cancer type any
    deployed model covers (or not H&E tissue at all). Becomes HTTP 422 with a
    structured body so the frontend can show a "not supported" state instead
    of a generic error.

    `tissue` is the router's verdict as the Modal app returns it:
    {code, label, prob, supported: False, reason, ...}.
    """

    def __init__(self, message: str, tissue: dict | None = None):
        super().__init__(message)
        self.message = message
        self.tissue = tissue or {}
