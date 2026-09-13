"""Google Cloud Storage 索引檔讀寫（v2）。

索引以 JSON 存於 gs://{GCS_BUCKET}/index.json，以 Drive FileID 為主鍵：
{
  "version": 2,
  "items": {
    "<file_id>": {"individual_id": "TW00019", "side": "left", "species": "綠蠵龜", "feature": [..]}
  }
}
JSON 而非 pickle：pickle.loads 對任意位元組等同執行程式碼，有 RCE 風險。
"""
from __future__ import annotations

import json
import logging
import os

import numpy as np
from google.cloud import storage

logger = logging.getLogger(__name__)

GCS_BUCKET = os.environ.get("GCS_BUCKET", "")
INDEX_BLOB_NAME = os.environ.get("INDEX_BLOB_NAME", "index.json")
VALID_SIDES = ("left", "right")


def empty_index() -> dict:
    return {"version": 2, "items": {}}


def _decode(raw: dict) -> dict:
    index = empty_index()
    items = raw.get("items", {}) if isinstance(raw, dict) else {}
    for fid, entry in items.items():
        if not isinstance(entry, dict) or entry.get("side") not in VALID_SIDES:
            continue
        try:
            feature = np.asarray(entry.get("feature", []), dtype=np.float32)
        except (TypeError, ValueError):
            continue
        if feature.ndim != 1 or feature.size == 0:
            continue
        index["items"][str(fid)] = {
            "individual_id": str(entry.get("individual_id", "")),
            "side": entry["side"],
            "species": str(entry.get("species", "")),
            "feature": feature,
        }
    return index


def _encode(index: dict) -> dict:
    return {
        "version": 2,
        "items": {
            fid: {
                "individual_id": e["individual_id"],
                "side": e["side"],
                "species": e["species"],
                "feature": np.asarray(e["feature"], dtype=np.float32).tolist(),
            }
            for fid, e in index.get("items", {}).items()
        },
    }


class IndexStorage:
    def __init__(self, bucket_name: str = GCS_BUCKET, blob_name: str = INDEX_BLOB_NAME) -> None:
        if not bucket_name:
            raise RuntimeError("GCS_BUCKET not configured")
        self.bucket_name = bucket_name
        self.blob_name = blob_name
        self._client: storage.Client | None = None

    @property
    def client(self) -> storage.Client:
        if self._client is None:
            self._client = storage.Client()
        return self._client

    @property
    def blob(self):
        return self.client.bucket(self.bucket_name).blob(self.blob_name)

    def load(self) -> dict:
        try:
            if not self.blob.exists():
                logger.warning("Index not found at gs://%s/%s, starting empty", self.bucket_name, self.blob_name)
                return empty_index()
            raw = json.loads(self.blob.download_as_bytes())
            index = _decode(raw)
            logger.info("Loaded index: %d photos", len(index["items"]))
            return index
        except Exception:
            logger.exception("Failed to load index; starting empty")
            return empty_index()

    def save(self, index: dict) -> None:
        payload = json.dumps(_encode(index)).encode("utf-8")
        self.blob.upload_from_string(payload, content_type="application/json")
        logger.info("Saved index to gs://%s/%s (%d bytes, %d photos)",
                    self.bucket_name, self.blob_name, len(payload), len(index["items"]))
