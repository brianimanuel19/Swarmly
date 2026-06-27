# AI / ML Stack Profile

## Languages & Frameworks
- **Language**: Python 3.11+
- **ML Framework**: PyTorch 2.x (CPU or CUDA)
- **API**: FastAPI + uvicorn for model serving
- **Experiment Tracking**: MLflow
- **Data**: Pandas, NumPy, scikit-learn
- **LLM Integration**: Transformers (HuggingFace) or Anthropic SDK
- **Notebooks**: Jupyter (for exploration only)

## Coding Standards
- Type hints everywhere (mypy strict)
- Pydantic v2 for data validation and API schemas
- Separate: data loading, preprocessing, training, evaluation, serving
- No global state — use dependency injection in FastAPI
- Log metrics with MLflow: loss, accuracy, latency per epoch
- Model artifacts: save with torch.save() or mlflow.pytorch.log_model()
- Reproducibility: set random seeds, log hyperparameters

## Project Structure
```
src/
  data/          # Dataset classes, data loaders
  models/        # Model architectures
  training/      # Training loops
  evaluation/    # Metrics, evaluation scripts
  serving/       # FastAPI app, inference
  utils/         # Common utilities
notebooks/       # Exploration only (not production)
tests/
  test_model.py
  test_api.py
configs/         # YAML config files for experiments
mlruns/          # MLflow artifacts (gitignored)
```

## Testing Stack
- **Unit**: pytest
- **API**: pytest + httpx (async)
- **Model**: test shape/dtype of outputs, check loss decreases
- **Coverage**: pytest-cov
- **File naming**: `test_*.py`

## Common Patterns
- Dataset: subclass torch.utils.data.Dataset
- Training loop: use Lightning or custom with tqdm progress
- Inference: batch processing, async FastAPI endpoint
- Monitoring: log inference latency, input distributions
