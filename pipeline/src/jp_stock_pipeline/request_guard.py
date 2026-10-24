"""Job-local send admission. No retry, timeout substitution, or unknown-result release."""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar


class RequestNotStartedError(RuntimeError):
    """The next request was rejected before sending; earlier requests are not rolled back."""


_before_request: ContextVar[Callable[[], None] | None] = ContextVar("before_request", default=None)


def assert_request_allowed() -> None:
    guard = _before_request.get()
    if guard is not None:
        try:
            guard()
        except Exception as exc:
            raise RequestNotStartedError("scheduled_request_not_started") from exc


@contextmanager
def request_guard(guard: Callable[[], None]) -> Iterator[None]:
    token = _before_request.set(guard)
    try:
        yield
    finally:
        _before_request.reset(token)
