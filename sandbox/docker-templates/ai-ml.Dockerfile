FROM python:3.11-slim
RUN apt-get update && apt-get install -y curl git build-essential && rm -rf /var/lib/apt/lists/*
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install fastapi uvicorn pytest mlflow scikit-learn pandas numpy jupyter ipykernel transformers
RUN useradd -ms /bin/bash app
WORKDIR /workspace
RUN chown -R app:app /workspace
USER app
HEALTHCHECK --interval=30s --timeout=3s CMD python3 --version || exit 1
