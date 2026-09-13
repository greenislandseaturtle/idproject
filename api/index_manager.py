"""特徵索引管理（v2）：以 Drive FileID 為主鍵，支援同側＋同物種比對。

比對規則（由 Apps Script 決定 species 鍵後傳入）：
  綠蠵龜 ↔ 綠蠵龜、玳瑁 ↔ 玳瑁、其他 ↔ 其他；
  查詢物種為「無法判斷」→ 不限物種；索引內物種為「無法判斷」的照片對所有查詢都可見。
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone

import numpy as np

from storage import VALID_SIDES, IndexStorage, empty_index

logger = logging.getLogger(__name__)

SPECIES_ANY = "無法判斷"


class IndexManager:
    def __init__(self, storage_backend: IndexStorage | None = None) -> None:
        self.storage = storage_backend or IndexStorage()
        self._lock = threading.RLock()
        self._index: dict | None = None
        self._updated_at: str = ""

    @property
    def index(self) -> dict:
        if self._index is None:
            with self._lock:
                if self._index is None:
                    self._index = self.storage.load()
        return self._index

    def _save(self) -> None:
        self.storage.save(self.index)
        self._updated_at = datetime.now(timezone.utc).isoformat()

    # ---------- 查詢 ----------
    def stats(self) -> dict:
        with self._lock:
            items = self.index["items"].values()
            out = {"photos": len(self.index["items"]), "updated_at": self._updated_at}
            for side in VALID_SIDES:
                ids = {e["individual_id"] for e in items if e["side"] == side}
                out[f"{side}_individuals"] = len(ids)
                out[f"{side}_photos"] = sum(1 for e in items if e["side"] == side)
            return out

    def manifest(self) -> dict:
        """給 Apps Script 做差集用：不含特徵向量。"""
        with self._lock:
            return {
                "items": {
                    fid: {"individual_id": e["individual_id"], "side": e["side"], "species": e["species"]}
                    for fid, e in self.index["items"].items()
                },
                "updated_at": self._updated_at,
            }

    def compare(self, query_vec: np.ndarray, side: str, species: str, top_k: int = 5) -> list[dict]:
        """同側、同物種鍵比對；每個個體取其所有照片中最高分。向量已 L2-normalized，點積即餘弦相似度。"""
        if side not in VALID_SIDES:
            raise ValueError(f"side must be one of {VALID_SIDES}")
        species = (species or "").strip()
        with self._lock:
            groups: dict[str, list[np.ndarray]] = {}
            for e in self.index["items"].values():
                if e["side"] != side:
                    continue
                if species and species != SPECIES_ANY and e["species"] not in (species, SPECIES_ANY):
                    continue
                groups.setdefault(e["individual_id"], []).append(e["feature"])
            scores = []
            for iid, feats in groups.items():
                sims = np.stack(feats, axis=0) @ query_vec
                scores.append((iid, float(np.max(sims))))
        scores.sort(key=lambda x: x[1], reverse=True)
        return [{"individual_id": iid, "similarity": round(sim, 4)} for iid, sim in scores[:top_k]]

    # ---------- 維護 ----------
    def apply(self, adds: list[tuple[str, str, str, str, np.ndarray]] | None = None,
              removes: list[str] | None = None,
              species_updates: list[tuple[str, str]] | None = None) -> dict:
        """一次套用多項變更後只寫回 GCS 一次。

        adds: (file_id, individual_id, side, species, vector)
        removes: file_id 列表
        species_updates: (file_id, species)
        """
        added = removed = updated = 0
        with self._lock:
            items = self.index["items"]
            for fid in removes or []:
                if items.pop(fid, None) is not None:
                    removed += 1
            for fid, species in species_updates or []:
                if fid in items:
                    items[fid]["species"] = species
                    updated += 1
            for fid, iid, side, species, vec in adds or []:
                if side not in VALID_SIDES:
                    continue
                items[fid] = {
                    "individual_id": iid, "side": side, "species": species,
                    "feature": np.asarray(vec, dtype=np.float32),
                }
                added += 1
            if added or removed or updated:
                self._save()
        return {"added": added, "removed": removed, "species_updated": updated, "photos": len(self.index["items"])}

    def reset(self) -> None:
        with self._lock:
            self._index = empty_index()
            self._save()
