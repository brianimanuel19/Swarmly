# IoT / Embedded Stack Profile

## Languages & Frameworks
- **Firmware**: C/C++ with FreeRTOS or Arduino framework
- **Platform**: ESP32 / STM32 / Raspberry Pi Pico (PlatformIO)
- **Protocol**: MQTT (mosquitto / paho-mqtt)
- **Backend**: Python + FastAPI for device management API
- **Testing**: pytest + QEMU emulation or Wokwi simulator

## Coding Standards
- C: C99 standard, no dynamic allocation in ISR context
- Use RTOS tasks for concurrent operations (vTaskCreate)
- MQTT topics: `device/{id}/telemetry`, `device/{id}/command`, `device/{id}/status`
- Always handle disconnections and reconnection logic
- Watchdog timers for production firmware
- Error codes as enum, not magic numbers
- All buffer operations: bounds checking

## Project Structure
```
firmware/
  src/
    main.c / main.cpp     # Entry point
    tasks/                # FreeRTOS tasks
    drivers/              # Hardware drivers
    mqtt/                 # MQTT client
    config.h              # Pin definitions, constants
  platformio.ini
backend/
  api/                    # FastAPI device API
  models/                 # Data models
  mqtt_broker/            # MQTT bridge
tests/
  test_firmware/          # Unity or pytest-embedded
  test_backend/           # pytest
```

## Testing Stack
- **Firmware**: Unity test framework, Wokwi for simulation
- **Backend**: pytest + httpx for async API testing
- **Integration**: MQTT mock broker (mosquitto test instance)
- **Coverage**: gcov for C code

## Common Patterns
- Telemetry: JSON payload over MQTT
- OTA updates: ESP-IDF OTA component
- NTP sync for timestamps
- Deep sleep for battery-powered devices
