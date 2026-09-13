"""TurtleDetector：用 YOLO11（BVRA/TurtleDetector）偵測海龜頭部並裁切。

特徵擷取前先把整張照片裁成「海龜頭部」，去除背景雜訊，
大幅提升個體再辨識的鑑別力。偵測不到頭時退用整隻海龜框，
再不行則回傳原圖。
"""
from __future__ import annotations

import logging
import threading

from huggingface_hub import hf_hub_download
from PIL import Image
from ultralytics import YOLO

logger = logging.getLogger(__name__)

DETECTOR_REPO = "BVRA/TurtleDetector"
DETECTOR_FILE = "turtle_detector.pt"
# 裁切框外擴比例，避免裁太緊
CROP_MARGIN = 0.1


class TurtleDetector:
    """單例：載入一次 YOLO 模型，後續重複使用。"""

    _instance: "TurtleDetector | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        logger.info("Loading TurtleDetector %s ...", DETECTOR_REPO)
        path = hf_hub_download(repo_id=DETECTOR_REPO, filename=DETECTOR_FILE)
        self.model = YOLO(path)
        names = self.model.names  # {class_id: name}
        # 類別名稱不寫死：依關鍵字找出「頭部」與「海龜身體」類別
        self.head_ids = {i for i, n in names.items() if "head" in str(n).lower()}
        self.body_ids = {i for i, n in names.items()
                         if "turtle" in str(n).lower() and "head" not in str(n).lower()}
        logger.info("TurtleDetector loaded; classes=%s head_ids=%s body_ids=%s",
                    names, self.head_ids, self.body_ids)

    @classmethod
    def get(cls) -> "TurtleDetector":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def analyze(self, image: Image.Image) -> dict:
        """偵測診斷：回傳 {crop, kind, detections}。

        kind：head / body / full（裁到頭部 / 裁到整隻海龜 / 偵測不到回原圖）。
        detections：所有偵測框（類別、信心、座標）。
        """
        out = {"crop": image, "kind": "full", "detections": []}
        try:
            result = self.model.predict(image, verbose=False, save=False, show=False)[0]
            boxes = result.boxes
            if boxes is None or len(boxes) == 0:
                logger.info("detector: 無偵測結果，使用整張照片")
                return out
            names = self.model.names
            for i in range(len(boxes)):
                cid = int(boxes.cls[i])
                out["detections"].append({
                    "cls": str(names.get(cid, cid)),
                    "conf": round(float(boxes.conf[i]), 3),
                    "box": [round(float(v), 1) for v in boxes.xyxy[i].tolist()],
                })
            box = self._best_box(boxes, self.head_ids)
            kind = "head"
            if box is None:
                box = self._best_box(boxes, self.body_ids)
                kind = "body"
            if box is None:
                logger.info("detector: 偵測到物件但無頭/身體框，使用整張照片")
                return out
            out["crop"] = self._crop(image, box)
            out["kind"] = kind
            logger.info("detector: 裁切到 %s", kind)
            return out
        except Exception:
            logger.exception("TurtleDetector.analyze failed; using full image")
            return out

    def crop(self, image: Image.Image) -> Image.Image:
        """偵測並裁切到海龜頭部；偵測不到頭退用整隻海龜框，再不行回原圖。"""
        return self.analyze(image)["crop"]

    @staticmethod
    def _best_box(boxes, class_ids):
        """回傳屬於 class_ids 中信心最高的框 (x1,y1,x2,y2)；無則 None。"""
        if not class_ids:
            return None
        best_conf = -1.0
        best = None
        for i in range(len(boxes)):
            if int(boxes.cls[i]) in class_ids:
                conf = float(boxes.conf[i])
                if conf > best_conf:
                    best_conf = conf
                    best = boxes.xyxy[i].tolist()
        return best

    @staticmethod
    def _crop(image: Image.Image, box) -> Image.Image:
        x1, y1, x2, y2 = box
        w, h = image.size
        bw, bh = x2 - x1, y2 - y1
        x1 = max(0, x1 - bw * CROP_MARGIN)
        y1 = max(0, y1 - bh * CROP_MARGIN)
        x2 = min(w, x2 + bw * CROP_MARGIN)
        y2 = min(h, y2 + bh * CROP_MARGIN)
        if x2 - x1 < 1 or y2 - y1 < 1:
            return image
        return image.crop((int(x1), int(y1), int(x2), int(y2)))
