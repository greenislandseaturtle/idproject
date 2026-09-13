"""MegaDescriptor 模型載入與特徵擷取。

使用 BVRA/MegaDescriptor-L-384（Large 版本，輸入 384×384）。
特徵擷取前會先用 TurtleDetector 裁切到海龜頭部，去除背景雜訊。
特徵維度於模型載入時動態取得，用於個體再辨識（re-identification）。
"""
from __future__ import annotations

import logging
import threading
from io import BytesIO

import numpy as np
import timm
import torch
from PIL import Image, ImageOps
from torchvision import transforms

from detector import TurtleDetector

# 啟用 HEIC 解碼（iPhone 照片常見格式）
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

logger = logging.getLogger(__name__)

MODEL_NAME = "hf-hub:BVRA/MegaDescriptor-L-384"
INPUT_SIZE = 384

# ImageNet 標準化（MegaDescriptor 訓練使用的前處理）
_NORMALIZE_MEAN = (0.485, 0.456, 0.406)
_NORMALIZE_STD = (0.229, 0.224, 0.225)

_preprocess = transforms.Compose([
    transforms.Resize((INPUT_SIZE, INPUT_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(mean=_NORMALIZE_MEAN, std=_NORMALIZE_STD),
])


class FeatureExtractor:
    """單例特徵擷取器，模型載入一次後快取在記憶體。"""

    _instance: "FeatureExtractor | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        logger.info("Loading model %s ...", MODEL_NAME)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model = timm.create_model(MODEL_NAME, num_classes=0, pretrained=True)
        self.model.eval()
        self.model.to(self.device)
        # 從第一次推論取得特徵維度
        with torch.no_grad():
            dummy = torch.zeros(1, 3, INPUT_SIZE, INPUT_SIZE, device=self.device)
            self.feature_dim = int(self.model(dummy).shape[1])
        logger.info("Model loaded on %s, feature_dim=%d", self.device, self.feature_dim)

    @classmethod
    def get(cls) -> "FeatureExtractor":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def extract(self, image: Image.Image) -> np.ndarray:
        """從 PIL Image 擷取 L2-normalized 特徵向量（餘弦相似度比較用）。"""
        # 套用 EXIF 方向，避免被拍歪的照片以錯誤方向進模型
        image = ImageOps.exif_transpose(image)
        # 轉 RGB（去除 alpha 通道、處理灰階）
        if image.mode != "RGB":
            image = image.convert("RGB")
        # 裁切到海龜頭部，去除背景雜訊（偵測不到則回傳原圖）
        image = TurtleDetector.get().crop(image)
        tensor = _preprocess(image).unsqueeze(0).to(self.device)
        with torch.no_grad():
            features = self.model(tensor)
        vec = features.cpu().numpy().flatten().astype(np.float32)
        # L2 normalize：之後做點積即等於餘弦相似度
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return vec

    def extract_from_bytes(self, image_bytes: bytes) -> np.ndarray:
        """從 raw bytes 解碼並擷取特徵。"""
        image = Image.open(BytesIO(image_bytes))
        return self.extract(image)
