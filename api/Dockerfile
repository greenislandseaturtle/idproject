FROM python:3.11-slim

WORKDIR /app

# gcc 給編譯型 wheel；libheif 處理 HEIC；libgl/libglib 給 ultralytics 的 opencv
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libheif1 \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# CPU-only torch wheel：image 從約 4 GB 縮到約 1.5 GB，降低 Artifact Registry 費用與冷啟動時間
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY . .

ENV HF_HOME=/app/.cache/huggingface
ENV YOLO_CONFIG_DIR=/tmp/Ultralytics

# 預先下載模型權重，避免冷啟動時再下載
RUN python -c "from model import MODEL_NAME; import timm; timm.create_model(MODEL_NAME, num_classes=0, pretrained=True)"
RUN python -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='BVRA/TurtleDetector', filename='turtle_detector.pt')"

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
