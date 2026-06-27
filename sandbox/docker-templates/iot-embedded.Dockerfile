FROM python:3.11-slim
RUN apt-get update && apt-get install -y gcc-arm-none-eabi python3-pip mosquitto-clients curl git make && rm -rf /var/lib/apt/lists/*
RUN pip install platformio pyserial paho-mqtt pytest
RUN useradd -ms /bin/bash app
WORKDIR /workspace
RUN chown -R app:app /workspace
USER app
HEALTHCHECK --interval=30s --timeout=3s CMD python3 --version || exit 1
