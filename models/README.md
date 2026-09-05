# models

`cct_xs_v2_global.onnx` — license-plate OCR from [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) (MIT), model `cct-xs-v2-global-model`.
Input `[1,64,128,3]` uint8 RGB, output `plate` `[1,10,37]` softmax over `0-9A-Z_`. Runs on onnxruntime-node (CPU, ~50 ms on an Intel Air). Reads Argentine car and two-line moto plates.
