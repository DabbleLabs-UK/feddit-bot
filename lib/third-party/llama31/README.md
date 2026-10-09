# Built with Llama

Feddit Bots includes public Llama 3.1 tokenizer vocabulary and merge data for
offline hosted-prompt token counting. No model weights are bundled in this
tokenizer asset. The original tokenizer materials are licensed under the Llama
3.1 Community License Agreement reproduced in [LICENSE.txt](LICENSE.txt).
The required attribution is in [Notice.txt](Notice.txt).

Upstream model:
https://huggingface.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF

Official license source:
https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE

The license incorporates Meta's Acceptable Use Policy:
https://llama.meta.com/llama3_1/use-policy

The deterministic Unicode classification data and pre-tokenizer scanner are
derived from llama.cpp tag `b10864`, pinned by Ollama 0.34.1. Their MIT license
and copyright notice are reproduced in [llama.cpp-LICENSE.txt](llama.cpp-LICENSE.txt).
Source: https://github.com/ggml-org/llama.cpp/tree/b10864/src

Keep this entire directory with the tokenizer data when packaging Feddit Bots.
The bundled lib directory includes this product-documentation attribution,
the full agreement, and its required Notice text file. Any public distribution
must also prominently display "Built with Llama" in its related website, user
interface, blogpost, about page, or product documentation, as required by
section 1.b.i of the agreement. Include that attribution in the public release's
product documentation; retaining a license file alone does not replace it.
