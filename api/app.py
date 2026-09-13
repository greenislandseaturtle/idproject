"""綠島海龜個體辨識 Cloud Run API（v2）。

端點（除 /health 外皆需 X-API-Key；/index/* 另需 X-Admin-Token）：
  GET  /health
  POST /compare          file + side + species → 同側同物種前 5 名
  GET  /index/manifest   索引現況（不含向量），供 Apps Script 做差集
  POST /index/apply      JSON {adds:[{file_id, individual_id, side, species}], removes:[file_id], species_updates:[{file_id, species}]}
                         adds 由本服務自行從 Drive 下載照片並抽特徵
Cloud Run 以 --no-allow-unauthenticated 部署，Apps Script 以服務帳戶 OIDC token 呼叫。
"""
from __future__ import annotations

import logging
import os
import secrets
import time
from io import BytesIO

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from drive import DriveClient
from index_manager import IndexManager
from model import FeatureExtractor
from storage import VALID_SIDES

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s - %(message)s")
logger = logging.getLogger("turtle-api")

API_KEY = os.environ.get("API_KEY", "")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 50_000_000       # 防解壓縮炸彈
ALLOWED_MIME = {"image/jpeg", "image/png", "image/heic", "image/heif"}
MAX_APPLY_ADDS = 20

ERR_AUTH = "unauthorized"
ERR_BAD_REQUEST = "bad_request"
ERR_TOO_LARGE = "file_too_large"
ERR_BAD_FORMAT = "unsupported_format"
ERR_INTERNAL = "internal_error"
ERR_BAD_IMAGE = "invalid_image"

app = FastAPI(title="Turtle ID API", version="2.0.0")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    rid = secrets.token_hex(4)
    try:
        response = await call_next(request)
        logger.info("rid=%s %s %s status=%d duration_ms=%.1f", rid, request.method,
                    request.url.path, response.status_code, (time.time() - start) * 1000)
        return response
    except Exception:
        logger.exception("rid=%s %s %s exception", rid, request.method, request.url.path)
        return JSONResponse(status_code=500, content={"error": ERR_INTERNAL})


def _verify_api_key(x_api_key: str | None) -> None:
    if not API_KEY:
        raise HTTPException(status_code=503, detail="service_not_configured")
    if not x_api_key or not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail=ERR_AUTH)


def _verify_admin_token(token: str | None) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="admin_not_configured")
    if not token or not secrets.compare_digest(token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail=ERR_AUTH)


_extractor: FeatureExtractor | None = None
_manager: IndexManager | None = None
_drive: DriveClient | None = None


def get_extractor() -> FeatureExtractor:
    global _extractor
    if _extractor is None:
        _extractor = FeatureExtractor.get()
    return _extractor


def get_manager() -> IndexManager:
    global _manager
    if _manager is None:
        _manager = IndexManager()
    return _manager


def get_drive() -> DriveClient:
    global _drive
    if _drive is None:
        _drive = DriveClient()
    return _drive


def _open_image(raw: bytes) -> Image.Image:
    if not raw:
        raise HTTPException(status_code=400, detail=ERR_BAD_REQUEST)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=ERR_TOO_LARGE)
    try:
        img = Image.open(BytesIO(raw))
        w, h = img.size
        if w * h > MAX_IMAGE_PIXELS:
            raise HTTPException(status_code=400, detail=ERR_BAD_IMAGE)
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(status_code=400, detail=ERR_BAD_IMAGE)
    return img


def _validate_side(side: str) -> str:
    s = (side or "").strip().lower()
    if s not in VALID_SIDES:
        raise HTTPException(status_code=400, detail=ERR_BAD_REQUEST)
    return s


def _validate_individual_id(individual_id: str) -> str:
    s = (individual_id or "").strip().upper()
    if not s or len(s) > 30 or not s.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail=ERR_BAD_REQUEST)
    return s


def _validate_species(species: str) -> str:
    s = (species or "").strip()
    if len(s) > 20:
        raise HTTPException(status_code=400, detail=ERR_BAD_REQUEST)
    return s


def _validate_file_id(file_id: str) -> str:
    s = (file_id or "").strip()
    if not s or len(s) > 128 or not s.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(status_code=400, detail=ERR_BAD_REQUEST)
    return s


@app.get("/health")
async def health() -> dict:
    try:
        stats = _manager.stats() if _manager is not None else {}
        return {"status": "ok", "model_loaded": _extractor is not None, "stats": stats}
    except Exception:
        logger.exception("health check failed")
        return {"status": "degraded"}


@app.post("/compare")
async def compare(
    file: UploadFile = File(...),
    side: str = Form(...),
    species: str = Form(default=""),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
):
    _verify_api_key(x_api_key)
    if file.content_type not in ALLOWED_MIME:
        raise HTTPException(status_code=400, detail=ERR_BAD_FORMAT)
    side_norm = _validate_side(side)
    species_norm = _validate_species(species)
    img = _open_image(await file.read())
    try:
        vec = get_extractor().extract(img)
        return {"results": get_manager().compare(vec, side_norm, species_norm, top_k=5)}
    except HTTPException:
        raise
    except Exception:
        logger.exception("compare failed")
        raise HTTPException(status_code=500, detail=ERR_INTERNAL)


@app.get("/index/manifest")
async def index_manifest(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
):
    _verify_api_key(x_api_key)
    _verify_admin_token(x_admin_token)
    return get_manager().manifest()


class AddItem(BaseModel):
    file_id: str
    individual_id: str
    side: str
    species: str = ""


class SpeciesUpdate(BaseModel):
    file_id: str
    species: str = ""


class ApplyBody(BaseModel):
    adds: list[AddItem] = Field(default_factory=list)
    removes: list[str] = Field(default_factory=list)
    species_updates: list[SpeciesUpdate] = Field(default_factory=list)


@app.post("/index/apply")
async def index_apply(
    body: ApplyBody,
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    x_admin_token: str | None = Header(default=None, alias="X-Admin-Token"),
):
    _verify_api_key(x_api_key)
    _verify_admin_token(x_admin_token)
    if len(body.adds) > MAX_APPLY_ADDS:
        raise HTTPException(status_code=400, detail=ERR_BAD_REQUEST)

    removes = [_validate_file_id(f) for f in body.removes]
    species_updates = [(_validate_file_id(u.file_id), _validate_species(u.species)) for u in body.species_updates]

    adds = []
    failed: list[str] = []
    if body.adds:
        extractor = get_extractor()
        drive = get_drive()
        for item in body.adds:
            fid = _validate_file_id(item.file_id)
            iid = _validate_individual_id(item.individual_id)
            side = _validate_side(item.side)
            species = _validate_species(item.species)
            try:
                content = drive.download_file(fid)
                img = _open_image(content)
                adds.append((fid, iid, side, species, extractor.extract(img)))
            except Exception:
                logger.exception("index add failed for %s", fid)
                failed.append(fid)
    try:
        result = get_manager().apply(adds=adds, removes=removes, species_updates=species_updates)
        result["failed"] = failed
        return result
    except Exception:
        logger.exception("index apply failed")
        raise HTTPException(status_code=500, detail=ERR_INTERNAL)
