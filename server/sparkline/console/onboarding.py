"""First-run state: when someone first signed in to this console, where they are in the getting-started guide,
and when each node first answered. The one owner of the kv rows ``onboarding`` and ``node_first_seen``.
"""

from __future__ import annotations

from collections.abc import Iterable

from pydantic import TypeAdapter

from ..common.schema import Onboarding, OnboardingPatch
from .store import TOKEN_FP_KEY, Store

ONBOARDING_KEY = "onboarding"
FIRST_SEEN_KEY = "node_first_seen"
_FIRST_SEEN = TypeAdapter(dict[str, float])


def merge(row: Onboarding, patch: OnboardingPatch, now: float) -> Onboarding:
    """``row`` after ``patch``. The same patch twice gives the same row."""
    finished = row.finished
    if patch.finished is False:
        finished = None
    elif patch.finished and finished is None:
        finished = now
    return row.model_copy(update={"seen": sorted({*row.seen, *(patch.seen or ())}), "finished": finished})


class OnboardingStore:
    def __init__(self, store: Store, row: Onboarding, first_seen: dict[str, float]):
        self._store = store
        self.row = row
        self.first_seen = first_seen  # node_id -> when this console first received a sample from it

    @classmethod
    def open(cls, store: Store, node_ids: Iterable[str], now: float) -> OnboardingStore:
        """Read both rows, writing what is missing. A store that a console has run on before (it has the
        token row every release writes on its first start) was set up before this state existed: its guide is
        finished and its configured nodes count as seen, so none of them loses its node_offline alert. Only a
        store with neither row starts as a first run. Call this before anything writes the token row."""
        set_up = store.kv_has(ONBOARDING_KEY) or store.kv_has(TOKEN_FP_KEY)
        row = store.kv_read(ONBOARDING_KEY, Onboarding.model_validate)
        first_seen = store.kv_read(FIRST_SEEN_KEY, _FIRST_SEEN.validate_python)
        if row is not None and first_seen is not None:
            return cls(store, row, first_seen)
        if row is None:
            row = Onboarding(started=now, finished=now) if set_up else Onboarding()
        if first_seen is None:
            first_seen = dict.fromkeys(node_ids, now) if set_up else {}
        return cls(store, row, first_seen)._saved()

    @classmethod
    def demo(
        cls, store: Store, node_ids: Iterable[str], now: float, first_run: bool, sign_in: bool
    ) -> OnboardingStore:
        """A demo starts the same way every time, whatever its last run left in the demo store: finished
        with every node seen, or (``first_run``) as a new install. A demo without a token has no sign-in to
        stamp ``started``, so there its start counts as the first sign-in."""
        if first_run:
            return cls(store, Onboarding(started=None if sign_in else now), {})._saved()
        return cls(store, Onboarding(started=now, finished=now), dict.fromkeys(node_ids, now))._saved()

    def _saved(self) -> OnboardingStore:
        self._store.kv_set_atomically(
            {ONBOARDING_KEY: self.row.model_dump(), FIRST_SEEN_KEY: self.first_seen}
        )
        return self

    def signed_in(self, now: float) -> None:
        if self.row.started is None:
            self._set(self.row.model_copy(update={"started": now}))

    def patch(self, patch: OnboardingPatch, now: float) -> Onboarding:
        self._set(merge(self.row, patch, now))
        return self.row

    def _set(self, row: Onboarding) -> None:
        self._store.kv_set(ONBOARDING_KEY, row.model_dump())
        self.row = row

    def node_seen(self, node_id: str, now: float) -> None:
        self._store.kv_set(FIRST_SEEN_KEY, {**self.first_seen, node_id: now})
        self.first_seen[node_id] = now
