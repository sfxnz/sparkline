from __future__ import annotations

import json
import re
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sparkline.common.schema import NodeInfo, Sample
from sparkline.console import fit
from sparkline.console.app import create_app
from sparkline.console.config import ConsoleConfig
from sparkline.console.demo import DemoModel
from sparkline.console.demo_workstation import WorkstationModel
from sparkline.console.fit import (
    Estimate,
    LookupFailure,
    ModelFacts,
    estimate,
    fetch_facts,
    node_budget,
    parse_repo_id,
)
from sparkline.console.nodes import NodeSource

GIB = 2**30
T0 = 1_791_000_000.0
TOKEN = "s3cret-browser-token"
BEARER = {"Authorization": f"Bearer {TOKEN}"}
QWEN = ModelFacts(weights_bytes=16_381_470_720, num_layers=36, num_kv_heads=8, head_dim=128)


def repo_files(sizes: dict[str, int]) -> dict[str, object]:
    return {"siblings": [{"rfilename": name, "size": size} for name, size in sizes.items()]}


QWEN_INFO = repo_files({"config.json": 726, "model.safetensors": 16_381_470_720})
QWEN_CONFIG = {
    "hidden_size": 4096,
    "max_position_embeddings": 40960,
    "num_attention_heads": 32,
    "num_hidden_layers": 36,
    "num_key_value_heads": 8,
}


def test_the_worked_example_qwen3_8b_at_32k_context():
    est = estimate(QWEN, 32768, "bf16")
    assert est.kv_bytes_per_token == 144 * 1024
    assert est.kv_bytes == 4.5 * GIB
    assert round(est.weights_bytes / GIB, 1) == 15.3
    assert (est.total_low, est.total_high) == (23_334_639_820, 25_455_970_713)


def test_fp8_halves_the_kv_cache():
    assert estimate(QWEN, 1000, "fp8").kv_bytes * 2 == estimate(QWEN, 1000, "fp16").kv_bytes


def test_an_unknown_kv_cache_dtype_is_refused_not_guessed():
    with pytest.raises(ValidationError, match="unknown KV cache dtype"):
        fit.FitRequest(facts=QWEN, context_tokens=1, kv_dtype="q8_0")


def test_the_web_form_offers_exactly_the_kv_cache_dtypes_the_console_sizes():
    web = (Path(__file__).parents[2] / "web/src/views/fit/model.ts").read_text()
    assert set(re.findall(r"value: '([^']+)'", web)) == set(fit.KV_DTYPE_BYTES)


def gb10(available: int) -> tuple[NodeInfo, Sample]:
    m = DemoModel("spark1", T0)
    s = m.sample_at(T0, 1)
    return m.info, s.model_copy(update={"mem": s.mem.model_copy(update={"available": available})})


def workstation(used: list[int | None]) -> tuple[NodeInfo, Sample]:
    m = WorkstationModel("ws1", T0)
    s = m.sample_at(T0, 1)
    gpus = [g.model_copy(update={"vram_used": u}) for g, u in zip(s.gpu, used, strict=True)]
    return m.info, s.model_copy(update={"gpu": gpus})


def test_a_unified_memory_node_budgets_available_memory_minus_headroom():
    b = node_budget(*gb10(20 * GIB))
    assert (b.kind, b.bytes, b.available, b.gpu_vendor) == ("unified", 16 * GIB, 20 * GIB, "nvidia")
    assert node_budget(*gb10(1 * GIB)).bytes == 0


def test_a_dedicated_gpu_node_budgets_the_one_gpu_with_the_most_free_memory():
    info, sample = workstation([40 * GIB, 10 * GIB, 30 * GIB, None])
    total = info.gpus[1].vram_total
    b = node_budget(info, sample)
    assert (b.kind, b.gpu_index, b.bytes) == ("gpu", 1, total - 10 * GIB)


def test_no_budget_without_a_sample_or_without_reported_gpu_memory():
    info, sample = workstation([None] * 4)
    assert node_budget(info, None).kind == "unknown"
    assert node_budget(None, sample).kind == "unknown"
    assert "dedicated memory" in node_budget(info, sample).reason


def test_no_budget_when_the_memory_collector_has_no_reading():
    info, sample = gb10(0)
    empty = sample.model_copy(update={"mem": sample.mem.model_copy(update={"total": 0})})
    b = node_budget(info, empty)
    assert b.kind == "unknown" and "memory" in b.reason


@pytest.mark.parametrize(
    ("available_gib", "want"),
    [(34, "fits"), (30, "tight"), (26, "tight"), (25, "no")],
)
def test_verdict_compares_the_range_with_the_budget(available_gib, want):
    est = Estimate(weights_bytes=0, kv_bytes_per_token=0, kv_bytes=0, total_low=22 * GIB, total_high=30 * GIB)
    assert fit.verdict(est, node_budget(*gb10(available_gib * GIB))) == want


def test_verdict_is_unknown_without_a_budget():
    assert fit.verdict(estimate(QWEN, 1, "bf16"), node_budget(None, None)) == "unknown"


# -- Hugging Face lookup ------------------------------------------------------------------------------


class FakeHuggingFace:
    def __init__(self, routes: dict[str, httpx.Response | Exception]):
        self.routes = routes
        self.hosts: list[str] = []
        self.paths: list[str] = []
        self.credentials: set[str] = set()

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.hosts.append(f"{request.url.scheme}://{request.url.host}")
        self.paths.append(request.url.path)
        self.credentials |= {"authorization", "cookie"} & set(request.headers)
        answer = self.routes[request.url.path]
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def lookup(self, repo: str = "Qwen/Qwen3-8B"):
        repo_id = parse_repo_id(repo)
        assert repo_id is not None
        async with httpx.AsyncClient(transport=httpx.MockTransport(self.handle)) as client:
            return await fetch_facts(client, repo_id)


INFO_PATH = "/api/models/Qwen/Qwen3-8B"
CONFIG_PATH = "/Qwen/Qwen3-8B/resolve/main/config.json"
CACHED_PATH = "/api/resolve-cache/models/Qwen/Qwen3-8B/abc/config.json"
INDEX = "model.safetensors.index.json"
INDEX_PATH = f"/Qwen/Qwen3-8B/resolve/main/{INDEX}"
CACHED_INDEX_PATH = f"/api/resolve-cache/models/Qwen/Qwen3-8B/abc/{INDEX}"


def weight_index(*files: str) -> dict[str, object]:
    return {
        "metadata": {"total_size": 1},
        "weight_map": {f"layers.{i}.weight": f for i, f in enumerate(files)},
    }


def public_repo(info=QWEN_INFO, config=QWEN_CONFIG, index=None) -> dict[str, httpx.Response | Exception]:
    routes: dict[str, httpx.Response | Exception] = {
        INFO_PATH: httpx.Response(200, json=info),
        # Hugging Face answers /resolve/ with a relative redirect to its own cache path.
        CONFIG_PATH: httpx.Response(307, headers={"location": f"{CACHED_PATH}?etag=x"}),
        CACHED_PATH: httpx.Response(200, json=config),
    }
    if index is not None:
        routes[INDEX_PATH] = httpx.Response(307, headers={"location": f"{CACHED_INDEX_PATH}?etag=x"})
        routes[CACHED_INDEX_PATH] = httpx.Response(200, json=index)
    return routes


def indexed_repo(sizes: dict[str, int], *named: str, config=QWEN_CONFIG):
    """A repo whose index names ``named``, or every file in ``sizes`` when none is given."""
    return public_repo(repo_files({INDEX: 400, **sizes}), config, weight_index(*(named or sizes)))


async def test_lookup_reads_the_size_of_the_weights_and_the_model_shape():
    hf = FakeHuggingFace(public_repo())
    facts = await hf.lookup()
    assert facts == QWEN.model_copy(update={"repo": "Qwen/Qwen3-8B", "max_context": 40960})
    assert set(hf.hosts) == {"https://huggingface.co"}


async def test_lookup_falls_back_to_attention_heads_and_an_explicit_head_dim_wins():
    config = {"num_hidden_layers": 2, "num_attention_heads": 16, "hidden_size": 1024}
    facts = await FakeHuggingFace(public_repo(config=config)).lookup()
    assert (facts.num_kv_heads, facts.head_dim, facts.max_context) == (16, 64, None)
    facts = await FakeHuggingFace(public_repo(config={**config, "head_dim": 256})).lookup()
    assert facts.head_dim == 256


# Hugging Face's parameter counts and weight file sizes for four real 4-bit repos.
PACKED_REPOS = [
    pytest.param(
        {"I32": 6_525_288_448, "F16": 1_090_328_064},
        {
            "model-00001-of-00002.safetensors": 3_996_422_976,
            "model-00002-of-00002.safetensors": 1_574_406_784,
        },
        id="awq",
    ),
    pytest.param(
        {"F32": 225_344, "BF16": 394_177_536, "U8": 2_906_720_136},
        {"model.safetensors": 2_242_762_780},
        id="bitsandbytes",
    ),
    pytest.param(
        {"I32": 6_979_321_856, "F16": 1_052_315_648},
        {"model.safetensors": 5_735_720_552},
        id="compressed-tensors",
    ),
    pytest.param(
        {"U32": 7_615_283_200, "F16": 333_312},
        {"model.safetensors": 4_284_346_255},
        id="mlx",
    ),
]


@pytest.mark.parametrize(("parameters", "files"), PACKED_REPOS)
async def test_a_4_bit_repo_weighs_what_its_safetensors_files_hold(parameters, files):
    routes = indexed_repo(files) if len(files) > 1 else public_repo(info=repo_files(files))
    routes[INFO_PATH] = httpx.Response(
        200, json={"safetensors": {"parameters": parameters}, **json.loads(routes[INFO_PATH].content)}
    )
    facts = await FakeHuggingFace(routes).lookup()
    assert isinstance(facts, ModelFacts), facts
    assert estimate(facts, 1, "bf16").weights_bytes == sum(files.values())


COPIES = {"consolidated.safetensors": 7, "original/model.safetensors": 7, "model.fp32.safetensors": 14}


async def test_a_repo_with_no_index_weighs_its_model_safetensors_when_that_is_its_only_one():
    hf = FakeHuggingFace(public_repo(info=repo_files({"config.json": 726, "model.safetensors": 7})))
    assert (await hf.lookup()).weights_bytes == 7
    assert len(hf.hosts) == 3


def test_a_repo_with_no_index_and_other_safetensors_files_beside_its_model_safetensors_is_refused():
    # With no index some servers load only model.safetensors and some load every top-level .safetensors file.
    refused = fit.unindexed_weights(parse_repo_id("an-owner/a-model"), {**COPIES, "model.safetensors": 7})
    assert not isinstance(refused, int), refused
    assert "beside its model.safetensors" in refused.message
    assert "consolidated.safetensors, model.fp32.safetensors" in refused.cause


async def test_an_indexed_repo_weighs_the_files_its_index_names():
    shards = {"model-00001-of-000002.safetensors": 3, "model-00002-of-000002.safetensors": 4}
    from_zero = {f"model-0000{i}-of-00002.safetensors": size for i, size in enumerate((3, 2, 2))}
    under_another_name = {"model.safetensors-00001-of-00002.safetensors": 6, "layers-0.safetensors": 1}
    for weights in (shards, from_zero, under_another_name):
        hf = FakeHuggingFace(indexed_repo(weights, *weights))
        assert (await hf.lookup()).weights_bytes == 7
        assert len(hf.hosts) == 5


@pytest.mark.parametrize(
    ("left_out", "named"),
    [
        # vLLM's Kimi-Audio loads a subfolder of the repo it serves as a second weight source.
        pytest.param({"whisper-large-v3/model.safetensors": 3}, "whisper-large-v3/model", id="a-subfolder"),
        # vLLM's d3 and clef models load a file of their own beside the index's, by name.
        pytest.param({"readout.safetensors": 1}, "readout.safetensors", id="a-file-beside-them"),
        pytest.param({"original/model.safetensors": 7}, "original/model", id="a-copy-of-the-model"),
        pytest.param({"model.safetensors": 7}, "model.safetensors", id="a-single-file-not-named"),
    ],
)
async def test_an_indexed_repo_holding_a_safetensors_file_its_index_misses_is_refused(left_out, named):
    shards = {"model-00001-of-00002.safetensors": 3, "model-00002-of-00002.safetensors": 4}
    failure = await FakeHuggingFace(indexed_repo({**shards, **left_out}, *shards)).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "does not name every" in failure.problem.message
    assert named in failure.problem.cause
    assert "by hand" in failure.problem.fix


async def test_a_repo_with_no_index_and_a_safetensors_file_in_a_subfolder_is_refused():
    files = {"config.json": 726, "model.safetensors": 7, "onnx/model.fp32.safetensors": 14}
    failure = await FakeHuggingFace(public_repo(info=repo_files(files))).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "onnx/model.fp32.safetensors" in failure.problem.cause


async def test_the_upper_bound_path_answers_a_repo_whose_shards_are_its_only_safetensors_files():
    hf = FakeHuggingFace(public_repo(info=repo_files({"config.json": 726, **OVER_THE_CAP, **SHARDS})))
    facts = await hf.lookup()
    assert (facts.weights_bytes, facts.weights_upper_bound) == (12_000_000_000, True)


async def test_an_index_that_names_several_shard_families_weighs_every_one_of_them():
    families = {
        **{f"model-0000{i}-of-00002.safetensors": 5 for i in (1, 2)},
        **{f"packed_experts-0000{i}-of-00003.safetensors": 100 for i in (1, 2, 3)},
        **{f"extra_head-0000{i}-of-00002.safetensors": 20 for i in (1, 2)},
    }
    facts = await FakeHuggingFace(indexed_repo(families)).lookup()
    assert facts.weights_bytes == 350


@pytest.mark.parametrize(
    ("sizes", "named", "want"),
    [
        pytest.param(
            {"model.safetensors": 890, "model_extra.safetensors": 110},
            ["model.safetensors", "model_extra.safetensors"],
            1000,
            id="one-file-and-a-second-file-beside-it",
        ),
        pytest.param(
            {"model.safetensors": 897, "model_extra.safetensors": 60, "model_visual.safetensors": 43},
            ["model.safetensors", "model_extra.safetensors", "model_visual.safetensors"],
            1000,
            id="one-file-and-two-files-beside-it",
        ),
        pytest.param(
            {
                "model-00001-of-00002.safetensors": 500,
                "model-00002-of-00002.safetensors": 390,
                "extra.safetensors": 110,
            },
            ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors", "extra.safetensors"],
            1000,
            id="shards-and-a-file-under-another-name",
        ),
    ],
)
def test_weights_the_index_names_outside_the_usual_file_names_are_counted(sizes, named, want):
    repo = parse_repo_id("an-owner/a-model")
    assert fit.indexed_weights(repo, {INDEX: 400, **sizes}, weight_index(*named)) == want


OVER_THE_CAP = {INDEX: fit.MAX_RESPONSE_BYTES + 1}
SHARDS = {f"model-0000{i}-of-00003.safetensors": 4_000_000_000 for i in (1, 2, 3)}


async def test_an_index_too_large_to_read_is_answered_when_the_repo_holds_one_shard_family():
    hf = FakeHuggingFace(public_repo(info=repo_files({"config.json": 726, **OVER_THE_CAP, **SHARDS})))
    facts = await hf.lookup()
    assert (facts.weights_bytes, facts.weights_upper_bound) == (12_000_000_000, True)
    assert INDEX_PATH not in hf.paths


async def test_a_size_from_the_files_a_server_loads_is_not_called_an_upper_bound():
    assert (await FakeHuggingFace(public_repo()).lookup()).weights_upper_bound is False
    assert (await FakeHuggingFace(indexed_repo(SHARDS)).lookup()).weights_upper_bound is False


@pytest.mark.parametrize(
    ("sizes", "at_most"),
    [
        pytest.param(
            {**SHARDS, "extra_head-00001-of-00001.safetensors": 1}, "12.1 GB", id="a-second-shard-family"
        ),
        pytest.param(
            {**SHARDS, "model-00001-of-00004.safetensors": 1}, "12.1 GB", id="the-same-stem-and-another-count"
        ),
        pytest.param({**SHARDS, "model.safetensors": 1}, "12.1 GB", id="a-single-file-beside-the-shards"),
        pytest.param({**SHARDS, "vision/model.safetensors": 1}, "12.1 GB", id="a-file-in-a-subfolder"),
        pytest.param({"model.safetensors": 12_000_000_000}, "12.0 GB", id="one-file-and-no-shards"),
        pytest.param(
            {f"half/{name}": size for name, size in SHARDS.items()}, "12.0 GB", id="shards-in-a-subfolder"
        ),
    ],
)
async def test_an_index_too_large_to_read_is_refused_unless_the_repo_holds_one_shard_family(sizes, at_most):
    hf = FakeHuggingFace(public_repo(info=repo_files({**OVER_THE_CAP, **sizes})))
    failure = await hf.lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "too large" in failure.problem.message
    assert "1.0 MiB" in failure.problem.cause and "which files a server loads" in failure.problem.cause
    assert "by hand" in failure.problem.fix and f"at most {at_most}" in failure.problem.fix
    assert INDEX_PATH not in hf.paths


def test_a_repo_with_no_index_and_no_model_safetensors_is_refused_with_what_it_does_hold():
    repo = parse_repo_id("an-owner/a-model")
    shards = fit.unindexed_weights(repo, {f"model-0000{i}-of-00002.safetensors": 5 for i in (1, 2)})
    assert "no model.safetensors and no model.safetensors.index.json" in shards.message
    assert "model-00001-of-00002.safetensors, model-00002-of-00002.safetensors)" in shards.cause
    nested = fit.unindexed_weights(
        repo, {"unet/diffusion_pytorch_model.safetensors": 5, "model_index.json": 1}
    )
    assert "unet/diffusion_pytorch_model.safetensors" in nested.cause
    other_formats = fit.unindexed_weights(repo, {"model.Q4_K_M.gguf": 5, "pytorch_model.bin": 5})
    assert "no .safetensors files" in other_formats.cause


async def test_a_file_list_that_names_one_file_twice_is_refused():
    info = {"siblings": [{"rfilename": "model.safetensors", "size": size} for size in (5_000_000_000, 1)]}
    failure = await FakeHuggingFace(public_repo(info=info)).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "twice" in failure.problem.message and "model.safetensors" in failure.problem.cause


def refused(path: str, status: int) -> dict[str, httpx.Response | Exception]:
    return {**public_repo(), path: httpx.Response(status, json={"error": "Invalid username or password."})}


# The repo's own weight file is small, and a server loads the rest from the repo its config names.
SPEECH_INFO = repo_files({"config.json": 900, "model.safetensors": 1_365_000_000})
SPEECH_CONFIG = {**QWEN_CONFIG, "text_model_id": "some-org/some-70b-model"}
ADAPTER_INFO = repo_files(
    {"config.json": 700, "adapter_config.json": 600, "model.safetensors": 4_987_796_928}
)
DRAFT_CONFIG = {**QWEN_CONFIG, "num_hidden_layers": 1, "draft_vocab_size": 32_000}


@pytest.mark.parametrize(
    "config",
    [
        pytest.param(SPEECH_CONFIG, id="text_model_id"),
        pytest.param({**QWEN_CONFIG, "audio_model_id": "some-org/a-speech-model"}, id="audio_model_id"),
        pytest.param({**QWEN_CONFIG, "vision_model_id": "some-org/a-vision-model"}, id="vision_model_id"),
        pytest.param({**QWEN_CONFIG, "mm_vision_tower": "some-org/a-vision-model"}, id="mm_vision_tower"),
        pytest.param(
            {**QWEN_CONFIG, "text_config": {"audio_model_id": "some-org/a-speech-model"}}, id="nested"
        ),
        # The keys the three-pattern rule missed, and the five low numbers they let through.
        pytest.param({**QWEN_CONFIG, "llama_path": "some-org/a-70b-model"}, id="llama_path"),
        pytest.param({**QWEN_CONFIG, "base_model": "some-org/a-target-model"}, id="a-draft-models-target"),
        pytest.param(
            {**QWEN_CONFIG, "audio_tokenizer_name_or_path": "some-org/an-audio-tokenizer"},
            id="a-second-repo-this-repos-own-code-loads",
        ),
        pytest.param(
            {**QWEN_CONFIG, "mm_vision_tower_aux_list": ["some-org/a-vision-model"]}, id="in-a-list"
        ),
        pytest.param({**QWEN_CONFIG, "model_name": "some-org/a-vision-model"}, id="model_name"),
        pytest.param({**QWEN_CONFIG, "pretrained_asr": "some-org/an-asr-model"}, id="any-other-key"),
        # A local path with two segments has the shape of a repo id, and says the same thing.
        pytest.param({**QWEN_CONFIG, "text_model_id": "models/a-70b-model"}, id="a-local-path"),
    ],
)
async def test_a_repo_whose_config_names_a_model_outside_it_gets_no_size(config):
    hf = FakeHuggingFace(public_repo(info=SPEECH_INFO, config=config))
    failure = await hf.lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "holds a name that reads as another repo's" in failure.problem.message
    assert "by hand" in failure.problem.fix


async def test_the_refusal_says_what_the_config_holds_and_what_the_lookup_cannot_tell():
    failure = await FakeHuggingFace(public_repo(info=SPEECH_INFO, config=SPEECH_CONFIG)).lookup()
    assert failure.problem.cause == (
        "It holds some-org/some-70b-model under text_model_id. The lookup cannot tell whether a name like "
        "that is a model, or whether a server loads weights from it"
    )
    # The name may be a private repo, a part already inside this one, or a file path. The hint does not
    # hand it over as a model whose files can be added up.
    assert "some-org/some-70b-model" not in failure.problem.fix
    # Clause 5: the hint says to add the other model's size, not to add up this repo's Files tab.
    assert (
        "plus those of any model named there that the server loads as a separate model" in failure.problem.fix
    )


@pytest.mark.parametrize(
    "config",
    [
        # The repo a model was made from, which no loader reads weights from, at the top level and under it.
        pytest.param({"_name_or_path": "some-org/a-model"}, id="provenance"),
        pytest.param({"text_config": {"_name_or_path": "some-org/a-model"}}, id="provenance-nested"),
        # Model code, which transformers imports from there. A repo's own modeling_*.py is no different.
        pytest.param(
            {"auto_map": {"AutoConfig": "some-org/a-model--configuration_x.XConfig"}}, id="auto_map"
        ),
        pytest.param({"auto_map": {"AutoTokenizer": "some-org/a-tokenizer"}}, id="auto_map-tokenizer"),
        # The repo being looked up is not another repo.
        pytest.param({"base_model": "Qwen/Qwen3-8B"}, id="this-repo-itself"),
        pytest.param({"base_model": "qwen/qwen3-8b"}, id="this-repo-in-another-case"),
        # Not the shape of a repo id.
        pytest.param({"chat_template": "a/b/c"}, id="three-segments"),
        pytest.param({"dtype": "bfloat16"}, id="no-slash"),
    ],
)
async def test_a_config_string_that_is_not_another_repo_still_gets_a_size(config):
    facts = await FakeHuggingFace(public_repo(config={**QWEN_CONFIG, **config})).lookup()
    assert isinstance(facts, ModelFacts), facts


async def test_an_adapter_gets_no_size_even_when_it_is_saved_as_model_safetensors():
    failure = await FakeHuggingFace(public_repo(info=ADAPTER_INFO)).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "adapter" in failure.problem.message
    assert "adapter_config.json" in failure.problem.cause
    # base_model_name_or_path in that file is null for a real LoRA, so the refusal does not say the file
    # names the base model, only that there is one.
    assert "named there" not in failure.problem.cause
    assert "the base model's" in failure.problem.fix


@pytest.mark.parametrize(
    "config",
    [
        pytest.param({"num_target_layers": 93}, id="num_target_layers"),
        pytest.param({"target_layer_ids": [3, 11, 19]}, id="target_layer_ids"),
        pytest.param({"draft_vocab_size": 248_144}, id="draft_vocab_size"),
        pytest.param({"target_hidden_size": 8192}, id="target_hidden_size"),
        pytest.param({"target_model_type": "qwen3"}, id="target_model_type"),
    ],
)
async def test_a_draft_model_gets_no_size_even_when_it_names_no_target(config):
    # A draft model is served beside a target its config need not name: 43 of 1,417 cached full answers
    # were a draft, and each of them is a size far below what a server loads.
    files = {"config.json": 726, "model.safetensors": 778_000_000}
    failure = await FakeHuggingFace(
        public_repo(info=repo_files(files), config={**QWEN_CONFIG, **config})
    ).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "has the keys of a draft model" in failure.problem.message
    assert next(iter(config)) in failure.problem.cause
    assert "the target model's" in failure.problem.fix


async def test_a_draft_models_refusal_claims_nothing_about_what_a_server_loads():
    config = {**QWEN_CONFIG, "num_target_layers": 93, "target_hidden_size": 8192}
    problem = (await FakeHuggingFace(public_repo(config=config)).lookup()).problem
    assert problem.cause == (
        "It has num_target_layers, target_hidden_size, as a draft model's config does. A draft model "
        "drafts for a target model, and the lookup read nothing of that target"
    )
    assert "a server loads" not in problem.cause


# A weight file in a format the lookup never reads, by whether its name marks it as a copy or as training
# state. The names come from the census in .audit/evidence/D/round-6/census_formats.out.
@pytest.mark.parametrize(
    "name",
    [
        "codec.pth", "head.pt", "projector_final.pt", "cross_layer_info.pt", "static_query_weights.pt",
        "probe/000000__de.npz", "prepared/abc/inductor.bin", "vision_tower/pytorch_model.safetensors.pt",
        "checkpoint.pt", "model.ckpt.index.pt", "speaker/model.pth",
    ],
)  # fmt: skip
async def test_a_weight_file_in_another_format_takes_the_size_with_it(name):
    files = {"config.json": 726, "model.safetensors": 7, name: 5_000_000}
    failure = await FakeHuggingFace(public_repo(info=repo_files(files))).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "a format the lookup does not read" in failure.problem.message
    assert name in failure.problem.cause
    assert "by hand" in failure.problem.fix


@pytest.mark.parametrize(
    ("others", "cause"),
    [
        pytest.param(
            ["codec.pth"],
            "It holds codec.pth, and the lookup cannot tell whether a server loads that file",
            id="one-file",
        ),
        pytest.param(
            ["codec.pth", "head.pt"],
            "It holds codec.pth, head.pt, and the lookup cannot tell whether a server loads those files",
            id="two-files",
        ),
    ],
)
async def test_the_other_format_refusal_says_no_file_was_sized(others, cause):
    # The cause said "beside the safetensors files the lookup sized". This refusal comes before any sizing.
    files = {"config.json": 726, "model.safetensors": 7} | dict.fromkeys(others, 5_000_000)
    problem = (await FakeHuggingFace(public_repo(info=repo_files(files))).lookup()).problem
    assert problem.cause == cause


@pytest.mark.parametrize(
    "name",
    [
        "pytorch_model.bin", "pytorch_model-00001-of-00003.bin", "model.ckpt",
        "consolidated.00.pth", "consolidated.pth", "consolidated.01.pt",
        "original/consolidated.00/consolidated-00001-of-00008.pth",
        "openvino_model.bin", "openvino/openvino_model_qint8_quantized.bin", "ct2_int8/model.bin",
        "ggml-model-f16.bin", "ggml/ggml-model-q5_k.bin", "model.Q4_K_M.gguf", "gguf/mmproj-BF16.gguf",
        "nemo/weights/common.pt", "onnx/model.pt", "coreml/weights/weight.bin",
        "training_args.bin", "optimizer.pt", "scheduler.pt", "rng_state_3.pth", "scaler.pt",
    ],
)  # fmt: skip
async def test_a_copy_of_the_weights_or_training_state_leaves_the_size_alone(name):
    files = {"config.json": 726, "model.safetensors": 7, name: 5_000_000}
    facts = await FakeHuggingFace(public_repo(info=repo_files(files))).lookup()
    assert isinstance(facts, ModelFacts), facts
    assert facts.weights_bytes == 7


async def test_a_second_repo_takes_the_size_off_the_upper_bound_path_too():
    hf = FakeHuggingFace(public_repo(info=repo_files({**OVER_THE_CAP, **SHARDS}), config=SPEECH_CONFIG))
    failure = await hf.lookup()
    assert isinstance(failure, LookupFailure), failure
    assert "holds a name that reads as another repo's" in failure.problem.message


@pytest.mark.parametrize(
    ("routes", "message"),
    [
        (refused(CONFIG_PATH, 401), "is gated"),
        (refused(CONFIG_PATH, 404), "no config.json"),
        (refused(CONFIG_PATH, 500), "could not answer"),
        ({**public_repo(), CACHED_PATH: httpx.Response(200, content=b"<html>")}, "not JSON"),
        ({**public_repo(), CACHED_PATH: httpx.Response(200, json=["not an object"])}, "not a JSON object"),
    ],
)
async def test_a_config_the_lookup_cannot_read_takes_the_size_with_it(routes, message):
    failure = await FakeHuggingFace(routes).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert message in failure.problem.message
    assert "another repo" in failure.problem.cause


async def test_a_config_read_but_not_understood_keeps_neither_the_shape_nor_the_size():
    # The shape and the sign that the model reaches outside the repo come from the same config.json, so a
    # size the lookup cannot pair with a shape is a size it cannot say the model's own files hold.
    failure = await FakeHuggingFace(public_repo(config={"num_attention_heads": 16})).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert failure.shape is None
    assert "does not describe" in failure.problem.message


async def test_a_shape_read_without_a_size_is_still_filled_in():
    failure = await FakeHuggingFace(public_repo(info=repo_files({"model.Q4_K_M.gguf": 5}))).lookup()
    assert isinstance(failure, LookupFailure) and failure.shape is not None


async def test_no_index_is_asked_for_once_the_config_rules_the_size_out():
    hf = FakeHuggingFace(indexed_repo({"model.safetensors": 5}, config=SPEECH_CONFIG))
    assert isinstance(await hf.lookup(), LookupFailure)
    assert INDEX_PATH not in hf.paths


@pytest.mark.parametrize(
    ("routes", "message"),
    [
        (refused(INFO_PATH, 401), "no public model"),
        (refused(INFO_PATH, 404), "no public model"),
        (refused(CONFIG_PATH, 401), "is gated"),
        (refused(CONFIG_PATH, 404), "no config.json"),
        (refused(INFO_PATH, 500), "could not answer"),
        (refused(INFO_PATH, 429), "rate limit"),
        ({**indexed_repo({"model.safetensors": 5}), INDEX_PATH: httpx.Response(401)}, "is gated"),
        (
            public_repo(info=repo_files({"model.Q4_K_M.gguf": 5, "pytorch_model.bin": 5})),
            "no model.safetensors",
        ),
        (
            # With no config.json the lookup gives no size either, so that refusal is the one it reports.
            {**refused(CONFIG_PATH, 404), INFO_PATH: httpx.Response(200, json=repo_files({}))},
            "no config.json",
        ),
        (
            public_repo(info=repo_files({f"model-0000{i}-of-00002.safetensors": 5 for i in (1, 2)})),
            "no model.safetensors",
        ),
        (
            indexed_repo({"model-00001-of-00002.safetensors": 5}, "model-00002-of-00002.safetensors"),
            "does not hold",
        ),
        (
            indexed_repo(
                {"model.safetensors": 5, "model-00001-of-00001.safetensors": 5},
                "model-00001-of-00001.safetensors",
            ),
            "does not name every",
        ),
        (public_repo(repo_files({INDEX: 9, "model.safetensors": 5}), index={"metadata": {}}), "weight index"),
        (
            public_repo(repo_files({INDEX: 9, "model.safetensors": 5}), index={"weight_map": {"a": 1}}),
            "weight index",
        ),
        (
            public_repo(repo_files({INDEX: 9, "model.safetensors": 5}), index={"weight_map": {}}),
            "weight index",
        ),
        (public_repo(info=repo_files({"model.safetensors": 0})), "are empty"),
        (public_repo(info={"id": "Qwen/Qwen3-8B"}), "does not list"),
        (
            public_repo(info={"siblings": [{"rfilename": "model.safetensors", "size": "big"}]}),
            "does not list",
        ),
        (public_repo(config={"num_hidden_layers": 36}), "does not describe"),
        (public_repo(config=["not", "an", "object"]), "not a JSON object"),
        ({INFO_PATH: httpx.ConnectError("Name or service not known")}, "Could not reach huggingface.co"),
        ({INFO_PATH: httpx.Response(200, content=b"<html>")}, "not JSON"),
        ({INFO_PATH: httpx.Response(200, content=b"[" * 200_000)}, "not JSON"),
        (
            {INFO_PATH: httpx.Response(200, content=b" " * (fit.MAX_RESPONSE_BYTES + 1))},
            "file list of Qwen/Qwen3-8B is larger",
        ),
    ],
)
async def test_each_lookup_failure_is_a_problem_that_says_to_enter_the_facts_by_hand(routes, message):
    problem = (await FakeHuggingFace(routes).lookup()).problem
    assert message in problem.message
    assert "nter the model facts by hand" in problem.fix
    assert "Input should be" not in problem.cause and "Field required" not in problem.cause


QWEN_SHAPE = {"num_layers": 36, "num_kv_heads": 8, "head_dim": 128, "max_context": 40960}

# Every one of these configs holds a whole shape at its top level, and the lookup read it.
SECOND_MODEL = [
    pytest.param(
        public_repo(info=SPEECH_INFO, config=SPEECH_CONFIG), id="a-config-string-naming-another-repo"
    ),
    pytest.param(public_repo(info=ADAPTER_INFO), id="an-adapter"),
    pytest.param(public_repo(config=DRAFT_CONFIG), id="a-draft-models-keys"),
]


@pytest.mark.parametrize("routes", SECOND_MODEL)
async def test_a_refusal_over_a_second_model_fills_in_neither_a_size_nor_a_shape(routes):
    # The fifth verifier typed the size a draft model's refusal asked for, kept the one layer the lookup
    # had filled in from the draft's own config, and got Fits for a model that does not fit.
    failure = await FakeHuggingFace(routes).lookup()
    assert isinstance(failure, LookupFailure), failure
    assert failure.model_dump() == {"problem": failure.problem.model_dump(), "shape": None}
    assert "both the size and the shape" in failure.problem.fix
    assert "the model the server answers with" in failure.problem.fix


@pytest.mark.parametrize("routes", SECOND_MODEL)
def test_lookup_route_sends_nothing_to_fill_in_after_a_refusal_over_a_second_model(tmp_path, hf, routes):
    hf.routes = routes
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
    assert r.status_code == 502
    assert r.json() == {"problem": r.json()["problem"], "shape": None}


@pytest.mark.parametrize(
    ("routes", "message", "shape"),
    [
        pytest.param(
            public_repo(config={"num_attention_heads": 16}),
            "does not describe",
            None,
            id="weights-sized-and-no-shape-in-the-config",
        ),
        pytest.param(refused(CONFIG_PATH, 401), "is gated", None, id="nothing-read-and-a-gated-config"),
        pytest.param(
            public_repo(info=repo_files({**OVER_THE_CAP, **SHARDS}), config={"num_attention_heads": 16}),
            "does not describe",
            None,
            id="weights-bounded-and-no-shape-in-the-config",
        ),
        pytest.param(
            public_repo(info=repo_files({"model.Q4_K_M.gguf": 5}), config={}),
            "no model.safetensors",
            None,
            id="neither",
        ),
        pytest.param(refused(INFO_PATH, 401), "no public model", None, id="no-repo"),
        # A refusal over this repo's own files: the config it read is this model's, so its shape is too.
        pytest.param(
            public_repo(info=repo_files({**OVER_THE_CAP, **SHARDS, "model.safetensors": 5})),
            "too large",
            QWEN_SHAPE,
            id="an-index-too-large",
        ),
        pytest.param(
            public_repo(info=repo_files({"model.Q4_K_M.gguf": 5})),
            "no model.safetensors",
            QWEN_SHAPE,
            id="no-safetensors",
        ),
        pytest.param(
            public_repo(info=repo_files({"model.safetensors": 5, "vision/model.safetensors": 5})),
            "other safetensors files beside",
            QWEN_SHAPE,
            id="a-second-safetensors-file-and-no-index",
        ),
        pytest.param(
            public_repo(info=repo_files({"model.safetensors": 5, "codec.pth": 5})),
            "a format the lookup does not read",
            QWEN_SHAPE,
            id="a-weight-file-in-another-format",
        ),
        pytest.param(
            indexed_repo({"model.safetensors": 5, "extra.safetensors": 5}, "model.safetensors"),
            "does not name every",
            QWEN_SHAPE,
            id="a-safetensors-file-the-index-leaves-out",
        ),
        pytest.param(
            indexed_repo({"model-00001-of-00002.safetensors": 5}, "model-00002-of-00002.safetensors"),
            "does not hold",
            QWEN_SHAPE,
            id="an-index-naming-a-file-the-repo-lacks",
        ),
        pytest.param(
            public_repo(repo_files({INDEX: 9, "model.safetensors": 5}), index={"metadata": {}}),
            "weight index",
            QWEN_SHAPE,
            id="an-index-with-no-weight-map",
        ),
        pytest.param(
            {**indexed_repo({"model.safetensors": 5}), INDEX_PATH: httpx.Response(401)},
            "is gated",
            QWEN_SHAPE,
            id="a-gated-index",
        ),
        pytest.param(
            public_repo(info=repo_files({"model.safetensors": 0})),
            "are empty",
            QWEN_SHAPE,
            id="empty-weights",
        ),
    ],
)
async def test_a_refusal_fills_in_the_shape_alone_and_only_when_it_is_this_models(routes, message, shape):
    failure = await FakeHuggingFace(routes).lookup()
    assert message in failure.problem.message
    assert failure.model_dump() == {"problem": failure.problem.model_dump(), "shape": shape}


def test_lookup_route_sends_the_shape_a_refused_lookup_read(tmp_path, hf):
    hf.routes = public_repo(info=repo_files({"model.Q4_K_M.gguf": 5}))
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
    assert r.status_code == 502
    assert "no model.safetensors" in r.json()["problem"]["message"]
    assert r.json()["shape"] == QWEN_SHAPE


async def test_a_file_too_large_to_read_is_named_in_the_refusal():
    too_big = httpx.Response(200, content=b" " * (fit.MAX_RESPONSE_BYTES + 1))
    problem = (await FakeHuggingFace({**public_repo(), CACHED_PATH: too_big}).lookup()).problem
    assert problem.message == "The config.json of Qwen/Qwen3-8B is larger than the lookup reads"
    assert "at most 1.0 MiB" in problem.cause


async def test_a_rate_limit_says_to_try_again_later():
    assert (
        "Try again in a few minutes" in (await FakeHuggingFace(refused(INFO_PATH, 429)).lookup()).problem.fix
    )


BOOL_DIMS = {"num_hidden_layers": 4, "num_key_value_heads": 4, "num_attention_heads": 4, "hidden_size": 64}


@pytest.mark.parametrize(
    "config",
    [
        # true // true is 1, and an explicit num_key_value_heads keeps the booleans out of the shape.
        pytest.param({**BOOL_DIMS, "num_attention_heads": True, "hidden_size": True}, id="heads-and-hidden"),
        pytest.param({**BOOL_DIMS, "num_attention_heads": True, "hidden_size": 64}, id="heads"),
        pytest.param({**BOOL_DIMS, "num_attention_heads": 4, "hidden_size": True}, id="hidden"),
        pytest.param({**BOOL_DIMS, "num_hidden_layers": True}, id="layers"),
    ],
)
async def test_a_json_boolean_where_a_dimension_belongs_is_not_a_number(config):
    # true // true is 1 in Python, which gave a head size of 1 and a full answer for a config that
    # describes no model.
    failure = await FakeHuggingFace(public_repo(config=config)).lookup()
    assert not isinstance(failure, ModelFacts), failure
    assert "does not describe" in failure.problem.message


async def test_a_config_without_the_model_shape_names_the_keys_it_lacks():
    problem = (await FakeHuggingFace(public_repo(config={"num_attention_heads": 16})).lookup()).problem
    assert "num_hidden_layers" in problem.cause and "head_dim, or hidden_size" in problem.cause
    assert "num_key_value_heads" not in problem.cause


VISION_SHAPE = {"num_hidden_layers": 24, "num_attention_heads": 16, "hidden_size": 1024}


@pytest.mark.parametrize(
    ("config", "where"),
    [
        pytest.param(
            {"text_config": QWEN_CONFIG},
            "It found a shape one level down, in text_config. Type in the shape of the part that answers",
            id="in-a-sub-object",
        ),
        pytest.param(
            {"vision_config": VISION_SHAPE, "text_config": QWEN_CONFIG, "audio_config": {"d_model": 1280}},
            "It found a shape one level down, in text_config, vision_config. Type in the shape of the part "
            "that answers",
            id="in-two-sub-objects-and-not-a-third",
        ),
        # A text_config that holds no layer count. The hint sent the user to it all the same.
        pytest.param(
            {
                "text_config": {"model_type": "some-text-model", "vocab_size": 32064},
                "vision_config": {"image_size": 336},
            },
            "It found no shape one level down either. A shape under an older name such as n_layer is read "
            "off the config and typed in",
            id="sub-objects-without-a-shape",
        ),
        pytest.param(
            {"n_layer": 36, "n_head": 32, "n_embd": 4096},
            "It found no shape one level down either. A shape under an older name such as n_layer is read "
            "off the config and typed in",
            id="under-an-older-name",
        ),
    ],
)
async def test_a_shape_not_at_the_top_level_is_refused_and_the_hint_names_only_where_one_is(config, where):
    # The refusal said the config has no whole number above 0 for these keys, which is false of a config
    # that holds them one level down: 1,472 of 3,867 cached configs do.
    problem = (await FakeHuggingFace(public_repo(config=config)).lookup()).problem
    assert problem.cause.endswith("at its top level")
    assert all(key not in config for key in ("num_hidden_layers", "num_attention_heads", "head_dim"))
    assert problem.fix == (
        f"Enter the model facts by hand: the lookup reads the top level of config.json only. {where}"
    )


@pytest.mark.parametrize(
    "location",
    ["https://cdn.example/config.json", "http://huggingface.co/x", "https://huggingface.co.example/x"],
)
async def test_lookup_never_follows_a_redirect_off_huggingface_co(location):
    hf = FakeHuggingFace({**public_repo(), CONFIG_PATH: httpx.Response(302, headers={"location": location})})
    problem = (await hf.lookup()).problem
    assert "another host" in problem.message
    assert set(hf.hosts) == {"https://huggingface.co"}


@pytest.mark.parametrize(
    "location",
    [
        "https://user:pass@huggingface.co/steal",
        "https://evil.example%5C@huggingface.co/steal",
        "//user@huggingface.co/steal",
    ],
)
async def test_lookup_never_follows_a_redirect_whose_url_carries_a_user_name(location):
    # httpx reads the user info out of the URL and sends Authorization: Basic with it. The host is right,
    # so the off-host check does not see this one.
    hf = FakeHuggingFace({**public_repo(), CONFIG_PATH: httpx.Response(302, headers={"location": location})})
    problem = (await hf.lookup()).problem
    assert problem.message == "Hugging Face redirected the lookup to a URL carrying a user name"
    assert hf.credentials == set()
    assert "/steal" not in hf.paths


async def test_a_lookup_sends_no_cookie_an_earlier_answer_set():
    cookie = httpx.Response(200, json=QWEN_CONFIG, headers={"set-cookie": "session=abc; Path=/"})
    hf = FakeHuggingFace({**public_repo(), CACHED_PATH: cookie})
    async with httpx.AsyncClient(transport=httpx.MockTransport(hf.handle)) as client:
        for _ in range(3):
            await fetch_facts(client, parse_repo_id("Qwen/Qwen3-8B"))
    assert hf.credentials == set()
    assert len(hf.paths) == 9


async def test_lookup_gives_up_on_a_redirect_loop():
    hf = FakeHuggingFace({INFO_PATH: httpx.Response(307, headers={"location": INFO_PATH})})
    assert "kept redirecting" in (await hf.lookup()).problem.message
    assert len(hf.hosts) == fit.MAX_REDIRECTS + 1


@pytest.mark.parametrize(
    "raw", ["Qwen3-8B", "a/b/c", "../etc/passwd", "a/..", "a/b?x=1", "a/b#c", "-a/b", "a /b", "a/b%2F", ""]
)
def test_only_owner_slash_name_is_a_repo_id(raw):
    assert parse_repo_id(raw) is None


def test_a_repo_id_keeps_its_spelling():
    assert parse_repo_id(" google-bert/bert-base_uncased.v2 ") == "google-bert/bert-base_uncased.v2"


# -- routes ---------------------------------------------------------------------------------------------


def make(tmp_path, **cfg):
    return create_app(
        ConsoleConfig(token=TOKEN, agent_token="a", web_dist=tmp_path / "no-dist", **cfg), tmp_path / "data"
    )


@pytest.fixture
def hf(monkeypatch):
    fake = FakeHuggingFace(public_repo())
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(fake.handle), **kw)
    )
    return fake


class _Src(NodeSource):
    async def session(self) -> None:
        raise NotImplementedError


def body(**over):
    return {"facts": json.loads(QWEN.model_dump_json()), "context_tokens": 32768, "kv_dtype": "bf16"} | over


def test_the_fit_routes_need_a_signed_in_user(tmp_path, hf):
    with TestClient(make(tmp_path)) as c:
        assert c.get("/api/v1/fit/lookup?repo=Qwen/Qwen3-8B").status_code == 401
        assert c.post("/api/v1/fit/estimate", json=body()).status_code == 401
        wrong = {"Authorization": "Bearer wrong"}
        assert c.post("/api/v1/fit/estimate", json=body(), headers=wrong).status_code == 401
        cross_site = {**BEARER, "Origin": "http://elsewhere.example"}
        assert c.post("/api/v1/fit/estimate", json=body(), headers=cross_site).status_code == 403
    assert hf.hosts == []


def test_estimate_route_gives_the_range_and_a_verdict_per_node(tmp_path):
    with TestClient(make(tmp_path)) as c:
        cluster = c.app.state.cluster
        for node_id, available in (("roomy", 60 * GIB), ("snug", 27 * GIB), ("full", 8 * GIB)):
            info, sample = gb10(available)
            src = _Src(node_id, "http://127.0.0.1:1", cluster)
            cluster.add_source(src)
            src.got_hello(info)
            src.got_sample(sample.model_copy(update={"ts": time.time()}))
        cluster.add_source(_Src("silent", "http://127.0.0.1:2", cluster))
        r = c.post("/api/v1/fit/estimate", json=body(), headers=BEARER)
    assert r.status_code == 200
    got = r.json()
    assert got["estimate"] == json.loads(estimate(QWEN, 32768, "bf16").model_dump_json())
    assert [(n["node_id"], n["verdict"]) for n in got["nodes"]] == [
        ("roomy", "fits"),
        ("snug", "tight"),
        ("full", "no"),
        ("silent", "unknown"),
    ]
    assert got["nodes"][0]["budget"] == {
        "kind": "unified",
        "bytes": 56 * GIB,
        "available": 60 * GIB,
        "headroom": 4 * GIB,
        "gpu_vendor": "nvidia",
    }
    assert got["nodes"][3]["budget"] == {
        "kind": "unknown",
        "reason": "The node is connecting, so its free memory is not known",
    }


def test_estimate_route_refuses_facts_it_cannot_size(tmp_path):
    with TestClient(make(tmp_path)) as c:
        for bad in (
            body(kv_dtype="q4_0"),
            body(context_tokens=0),
            body(facts={**body()["facts"], "weights_bytes": 0}),
            body(facts={**body()["facts"], "num_layers": 0}),
            body(facts={**body()["facts"], "weights_bytes": True}),
            body(context_tokens=True),
        ):
            r = c.post("/api/v1/fit/estimate", json=bad, headers=BEARER)
            assert r.status_code == 422, bad
            assert r.json()["problem"]["message"] == "Invalid request"


def test_lookup_route_returns_the_facts(tmp_path, hf):
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
    assert r.status_code == 200
    assert ModelFacts.model_validate(r.json()) == QWEN.model_copy(
        update={"repo": "Qwen/Qwen3-8B", "max_context": 40960}
    )
    assert len(hf.hosts) == 3 and hf.credentials == set()


def test_lookup_route_reports_a_missing_repo_as_a_problem(tmp_path, hf):
    hf.routes = refused(INFO_PATH, 401)
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
    assert r.status_code == 502
    assert "by hand" in r.json()["problem"]["fix"]


def test_lookup_route_makes_no_outbound_call_for_a_bad_repo_id_or_when_turned_off(tmp_path, hf):
    with TestClient(make(tmp_path)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "../../etc/passwd"}, headers=BEARER)
        assert r.status_code == 422 and "by hand" in r.json()["problem"]["fix"]
    with TestClient(make(tmp_path / "off", hf_lookup=False)) as c:
        r = c.get("/api/v1/fit/lookup", params={"repo": "Qwen/Qwen3-8B"}, headers=BEARER)
        assert r.status_code == 403 and "by hand" in r.json()["problem"]["fix"]
        assert c.post("/api/v1/fit/estimate", json=body(), headers=BEARER).status_code == 200
    assert hf.hosts == []
