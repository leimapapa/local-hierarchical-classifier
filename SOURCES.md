# Sources and licenses

## Open decision model

**Verdict / OpenJev-style RLCD model**

- Repository: https://github.com/Heman10x-NGU/Verdict-open-jev
- Model: https://huggingface.co/heman10x/rlcd-modernbert-151m
- Model license: Apache-2.0
- Backbone described by the project: ModernBERT + GLiClass
- Browser path: ONNX Runtime Web with WebGPU/WASM

The repository describes the model as a 151M-parameter non-autoregressive decision engine with typed choices, scores, an explicit abstention route, and calibrated probabilities. It also publishes the browser playground architecture and its prompt contract.

## RLCD paper

OpenJev-RLCD: A Working RLCD Implementation

https://arxiv.org/abs/2609.38850

The paper describes the “calibrate, then reinforce” procedure and evaluates calibration with proper scoring rules.

## Benign catalog

The catalog in this project is **synthetic** and was created solely for demonstrating the software interface. It is not copied from a historical catalog and is not intended as a factual reference database.
