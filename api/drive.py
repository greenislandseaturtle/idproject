"""Google Drive 下載（v2）：索引同步時依 FileID 直接下載照片。

Cloud Run 上以服務帳戶的 ADC 讀取；Drive 根資料夾需分享（檢視者）給該服務帳戶。
"""
from __future__ import annotations

import io
import logging

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

logger = logging.getLogger(__name__)

MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024


class DriveClient:
    def __init__(self) -> None:
        self.service = build("drive", "v3", cache_discovery=False)

    def download_file(self, file_id: str) -> bytes:
        meta = self.service.files().get(fileId=file_id, fields="size,mimeType", supportsAllDrives=True).execute()
        size = int(meta.get("size") or 0)
        if size > MAX_DOWNLOAD_BYTES:
            raise ValueError(f"file too large: {size}")
        request = self.service.files().get_media(fileId=file_id, supportsAllDrives=True)
        buf = io.BytesIO()
        downloader = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buf.getvalue()
