import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// ── Types ───────────────────────────────────────────────────────────────────

interface StaticAssertion {
  name: string;
  check: string;
  test: (code: string) => boolean;
}

interface RuntimeAssertion {
  name: string;
  check: string;
  test: (output: RuntimeOutput) => boolean;
}

interface RuntimeOutput {
  ok: boolean;
  result?: any;
  error?: string;
  code?: number;
  calls: Array<{ method: string; params: any; timestamp: number }>;
  elapsed: number;
}

interface RuntimeTestConfig {
  function: string;
  args: any[];
  errorsToQueue?: any[];
}

interface EvalResult {
  evalId: string;
  config: 'with_skill' | 'without_skill';
  passed: number;
  total: number;
  failures: string[];
  outputPath: string;
}

interface EvalSpec {
  static: StaticAssertion[];
  runtime?: RuntimeTestConfig;
  runtimeAssertions?: RuntimeAssertion[];
}

// ── Static Assertions (existing) ────────────────────────────────────────────

const STATIC_ASSERTIONS: Record<string, StaticAssertion[]> = {
  e1: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_google_genai_constructor', check: "contains 'new GoogleGenAI'", test: (c) => /new\s+GoogleGenAI/.test(c) },
    { name: 'response_modalities_set', check: 'contains responseModalities with IMAGE', test: (c) => /responseModalities.*IMAGE/.test(c) },
    { name: 'parts_array_constructed', check: 'uses parts or Part[] to assemble inputs', test: (c) => /parts\s*:/.test(c) || /Part\[\]/.test(c) },
    { name: 'extracts_inline_data', check: 'accesses .inlineData.data for base64 output', test: (c) => /inlineData\.?data/.test(c) },
    { name: 'handles_thought_signature', check: 'references thoughtSignature', test: (c) => /thoughtSignature/.test(c) },
    { name: 'style_before_subject', check: 'style reference image appears before subject image in parts array', test: (c) => {
      const partsMatch = c.match(/const\s+parts\s*:\s*Part\[\]\s*=\s*\[[\s\S]*?\];/);
      if (!partsMatch) return false;
      const partsBlock = partsMatch[0];
      const styleIdx = partsBlock.search(/styleBase64/i);
      const subjectIdx = partsBlock.search(/subjectBase64/i);
      return styleIdx >= 0 && subjectIdx >= 0 && styleIdx < subjectIdx;
    }},
  ],
  e2: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'uses_contents_array', check: 'uses contents with role keys', test: (c) => /contents\s*:/.test(c) && /role\s*:\s*['"]model['"]/.test(c) },
    { name: 'model_turn_present', check: "has { role: 'model' } turn", test: (c) => /role\s*:\s*['"]model['"]/.test(c) },
    { name: 'thought_signature_on_image', check: 'attaches thoughtSignature to inlineData part', test: (c) => /inlineData.*[\s\S]{0,200}thoughtSignature/.test(c) || /thoughtSignature.*[\s\S]{0,200}inlineData/.test(c) },
    { name: 'thought_signature_on_text', check: 'attaches thoughtSignature to text part (if present)', test: (c) => /text\s*:[^}]*thoughtSignature/.test(c) },
    { name: 'refinement_prompt_last', check: 'refinement prompt is on a user turn', test: (c) => /role\s*:\s*['"]user['"]/.test(c) },
    { name: 'response_modalities_set', check: 'contains responseModalities with IMAGE', test: (c) => /responseModalities.*IMAGE/.test(c) },
    { name: 'has_degradation_fallback', check: 'has single-turn fallback when thoughtSignature is unavailable', test: (c) => /else\s*\{[\s\S]{0,400}single-turn|fallback|degradation|thoughtSig\s*===\s*undefined|!thoughtSig/.test(c) },
  ],
  e3: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'defines_evaluation_interface', check: 'defines EvaluationResult interface or type', test: (c) => /interface\s+EvaluationResult|type\s+EvaluationResult/.test(c) },
    { name: 'five_dimensions', check: 'references all 5 dimensions', test: (c) =>
      ['subject_fidelity', 'style_accuracy', 'instruction_following', 'creativity', 'overall']
        .every(d => c.includes(d)) },
    { name: 'uses_gemini_25_flash', check: "uses 'gemini-2.5-flash' for evaluation", test: (c) => /gemini-2\.5-flash/.test(c) },
    { name: 'no_image_config', check: 'does NOT use imageConfig or responseModalities in eval call', test: (c) => {
      const evalCall = c.match(/evaluateImage[\s\S]*?\}\s*\)/)?.[0] ?? c;
      return !(/imageConfig/.test(evalCall) && /responseModalities/.test(evalCall));
    }},
    { name: 'parses_json', check: 'handles JSON parsing', test: (c) => /JSON\.parse|match\(.*\{/.test(c) },
    { name: 'convergence_check', check: 'implements shouldConverge with threshold', test: (c) => /shouldConverge/.test(c) && /threshold/.test(c) },
    { name: 'nested_scores_object', check: 'EvaluationResult uses nested scores: { scores: { dimension: number } }', test: (c) => /scores\s*:\s*\{[\s\S]{0,200}subject_fidelity|scores\s*:\s*Record/.test(c) },
    { name: 'uses_gemini_api_key', check: 'uses GEMINI_API_KEY (not GOOGLE_API_KEY)', test: (c) => /GEMINI_API_KEY/.test(c) },
  ],
  e4: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_files_upload', check: 'uses ai.files.upload()', test: (c) => /files\.upload/.test(c) },
    { name: 'uses_createPartFromUri', check: 'uses createPartFromUri()', test: (c) => /createPartFromUri/.test(c) },
    { name: 'handles_403_fallback', check: 'has 403 or fallback to inlineData logic', test: (c) => /403|fallback|inlineData.*catch|catch.*inlineData/.test(c) },
    { name: 'returns_image_base64', check: 'extracts and returns generated image base64', test: (c) => /inlineData\??\.data/.test(c) },
    { name: 'mentions_ttl_or_cache', check: 'mentions cache duration or TTL', test: (c) => /ttl|TTL|cache|47|expir/.test(c) },
  ],
  e5: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'uses_pic_n_regex', check: 'uses regex to match [pic_N] tokens', test: (c) => /\\\[pic_\\d+\\\]|\[pic_/.test(c) },
    { name: 'returns_part_array', check: 'returns Part[]', test: (c) => /Part\[\]/.test(c) },
    { name: 'alternates_text_and_images', check: 'produces alternating text/image sequence', test: (c) => /text.*push|push.*text/.test(c) && /push.*imagePart|imagePart.*push/.test(c) },
    { name: 'handles_missing_refs', check: 'handles missing pic references gracefully (keeps token as text)', test: (c) => /else\s*\{[\s\S]{0,100}text.*token|token.*text/.test(c) || /\{\s*text\s*:\s*token/.test(c) },
    { name: 'uses_map_param', check: 'uses Map<number, Part> for picMap', test: (c) => /Map\s*<\s*number\s*,\s*Part\s*>/.test(c) },
  ],
  e6: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'uses_abort_controller', check: 'creates AbortController', test: (c) => /AbortController/.test(c) },
    { name: 'has_timeout', check: 'has setTimeout for abort', test: (c) => /setTimeout.*abort|30000/.test(c) },
    { name: 'classifies_errors', check: 'classifies into RATE_LIMIT/TIMEOUT/CONTENT_POLICY', test: (c) => /RATE_LIMIT|TIMEOUT|CONTENT_POLICY/.test(c) },
    { name: 'has_retry_logic', check: 'has exponential backoff retry', test: (c) => /retry|retries|backoff|Math\.pow/.test(c) },
    { name: 'content_policy_no_retry', check: 'CONTENT_POLICY throws without retry', test: (c) => /CONTENT_POLICY/.test(c) && (/throw/.test(c) || /continue/.test(c)) },
    { name: 'passes_signal', check: 'passes abort signal to generateContent', test: (c) => /signal.*generateContent|generateContent.*signal/.test(c) || /signal\s*:/.test(c) },
  ],
  e7: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_generateContentStream', check: 'uses generateContentStream', test: (c) => /generateContentStream/.test(c) },
    { name: 'for_await_loop', check: 'uses for await...of to iterate chunks', test: (c) => /for\s+await|for\s*\(\s*await/.test(c) },
    { name: 'accumulates_parts', check: 'accumulates parts from chunks', test: (c) => /push|concat|spread/.test(c) },
    { name: 'extracts_image', check: 'extracts generated image base64', test: (c) => /inlineData\??\.data/.test(c) },
    { name: 'handles_abort', check: 'accepts or uses AbortController/signal', test: (c) => /AbortController|signal/.test(c) },
  ],
  e8: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_caches_create', check: 'uses ai.caches.create()', test: (c) => /caches\.create/.test(c) },
    { name: 'uses_gemini_25_flash', check: 'uses gemini-2.5-flash', test: (c) => /gemini-2\.5-flash/.test(c) },
    { name: 'has_cleanup', check: 'has cache cleanup or delete logic', test: (c) => /delete|cleanup|finally/.test(c) },
    { name: 'passes_image', check: 'passes image as inlineData in contents', test: (c) => /inlineData/.test(c) },
  ],
  e9: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_editImage', check: 'uses ai.models.editImage()', test: (c) => /editImage/.test(c) },
    { name: 'uses_bgswap', check: 'uses EDIT_MODE_BGSWAP', test: (c) => /EDIT_MODE_BGSWAP/.test(c) },
    { name: 'uses_mask_mode_background', check: 'uses MASK_MODE_BACKGROUND', test: (c) => /MASK_MODE_BACKGROUND/.test(c) },
    { name: 'uses_object_assign_raw', check: 'uses Object.assign for RawReferenceImage', test: (c) => /Object\.assign\(\s*new\s+RawReferenceImage/.test(c) },
    { name: 'uses_object_assign_mask', check: 'uses Object.assign for MaskReferenceImage', test: (c) => /Object\.assign\(\s*new\s+MaskReferenceImage/.test(c) },
    { name: 'no_constructor_args_raw', check: 'does NOT call new RawReferenceImage({...})', test: (c) => !/new\s+RawReferenceImage\s*\(\s*\{/.test(c) },
    { name: 'no_constructor_args_mask', check: 'does NOT call new MaskReferenceImage({...})', test: (c) => !/new\s+MaskReferenceImage\s*\(\s*\{/.test(c) },
  ],
  e11: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_interleave', check: 'uses interleaveInstructionParts or equivalent regex+slice', test: (c) => /interleaveInstructionParts|\[pic_|RegExp|slice/.test(c) },
    { name: 'three_pic_refs', check: 'references [pic_1], [pic_2], [pic_3]', test: (c) => /\[pic_1\].*\[pic_2\].*\[pic_3\]|\[pic_3\]/.test(c) },
    { name: 'has_guardrails', check: 'includes guardrail text (preserve / do NOT copy / maintain)', test: (c) => /preserve|maintain|do not copy|never copy|keep.*original/i.test(c) },
    { name: 'response_modalities_set', check: 'contains responseModalities with IMAGE', test: (c) => /responseModalities.*IMAGE/.test(c) },
    { name: 'imageConfig_2k', check: 'uses imageSize 2K', test: (c) => /imageSize.*2K|2K.*imageSize/.test(c) },
  ],
  r1: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'two_images', check: 'puts both images into the generation call', test: (c) => /subjectBase64|costumeRefBase64|pikachu|charizard/i.test(c) },
    { name: 'subject_preservation', check: 'mentions preserving subject identity', test: (c) => /preserve|keep|maintain.*face|keep.*shape|electric.*cheek|original/i.test(c) },
    { name: 'style_copy', check: 'mentions copying style elements', test: (c) => /wing|texture|flame|color.*scheme|style/i.test(c) },
    { name: 'parts_ordering', check: 'style reference before subject in parts array', test: (c) => { const partsBlock = c.match(/const\s+parts\s*:\s*Part\[\]\s*=\s*\[[\s\S]*?\];/)?.[0] ?? c; const refIdx = partsBlock.search(/costumeRefBase64|charizard|styleRef/i); const subIdx = partsBlock.search(/subjectBase64|pikachu/i); return refIdx >= 0 && subIdx >= 0 && refIdx < subIdx; } },
    { name: 'response_modalities', check: 'uses responseModalities', test: (c) => /responseModalities.*IMAGE|responseModalities.*Image/i.test(c) },
  ],
  r2: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'two_images', check: 'puts both images into the generation call', test: (c) => /subjectBase64|designRefBase64|waifu|gardevoir/i.test(c) },
    { name: 'identity_guardrail', check: 'explicitly states NOT to turn subject into reference', test: (c) => /not.*turn|do not.*become|remain.*herself|keep.*identity|not.*gardevoir/i.test(c) },
    { name: 'selective_copy', check: 'lists specific design elements to copy', test: (c) => /palette|posture|headpiece|color|green.*white|elegant|horn/i.test(c) },
    { name: 'parts_order', check: 'design reference before subject in parts array', test: (c) => { const partsBlock = c.match(/const\s+parts\s*:\s*Part\[\]\s*=\s*\[[\s\S]*?\];/)?.[0] ?? c; const refIdx = partsBlock.search(/designRefBase64|gardevoir|styleRef/i); const subIdx = partsBlock.search(/subjectBase64|waifu/i); return refIdx >= 0 && subIdx >= 0 && refIdx < subIdx; } },
    { name: 'response_modalities', check: 'uses responseModalities', test: (c) => /responseModalities.*IMAGE|responseModalities.*Image/i.test(c) },
  ],
  r3: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'three_images', check: 'uses all three images', test: (c) => /productBase64|moodBase64|logoBase64|watch|logo/i.test(c) },
    { name: 'interleave_or_refs', check: 'uses interleaving or multiple refs', test: (c) => /interleave|\[pic_|Map|referenceImages/i.test(c) || (c.match(/inlineData/g)?.length ?? 0) >= 3 },
    { name: 'color_guardrail', check: 'guards against background color bleed', test: (c) => /exact.*original|keep.*color|do not.*change|not.*let|color.*bleed|preserve.*metal|warm.*tone/i.test(c) },
    { name: 'logo_placement', check: 'mentions logo placement', test: (c) => /logo.*corner|subtle.*logo|top.right|unobtrusive/i.test(c) },
    { name: 'response_modalities', check: 'uses responseModalities', test: (c) => /responseModalities.*IMAGE|responseModalities.*Image/i.test(c) },
  ],
  r4: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'thought_sig', check: 'uses thoughtSignature', test: (c) => /thoughtSignature|thoughtSig/i.test(c) },
    { name: 'three_turn', check: 'has user/model/user turn structure', test: (c) => /role.*model/.test(c) },
    { name: 'fallback', check: 'has fallback when thoughtSignature missing', test: (c) => /else|fallback|!thoughtSig|thoughtSig.*undefined|single.turn/i.test(c) },
    { name: 'feedback_in_prompt', check: 'includes user feedback in refinement', test: (c) => /userFeedback|feedback|cleaner.*background|softer.*lighting|cluttered|harsh/i.test(c) },
    { name: 'response_modalities', check: 'uses responseModalities', test: (c) => /responseModalities.*IMAGE|responseModalities.*Image/i.test(c) },
  ],
  r5: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'cheap_model', check: 'uses gemini-2.5-flash (not image-gen)', test: (c) => /gemini-2\.5-flash/.test(c) && !/gemini-3.*image|imagen/.test(c) },
    { name: 'no_image_config', check: 'no imageConfig/responseModalities in eval', test: (c) => { const m = c.match(/generateContent[\s\S]{0,400}/i); const block = m ? m[0] : c; return !(/imageConfig/.test(block) && /responseModalities/.test(block)); } },
    { name: 'dimensions', check: 'scores on at least 3 dimensions', test: (c) => /match|lighting|color|fidelity|quality|overall/i.test(c) },
    { name: 'flagging', check: 'flags low scores', test: (c) => /flag|threshold|4|below|regenerate/i.test(c) },
    { name: 'batch_loop', check: 'iterates over multiple images', test: (c) => /for.*images|map|Promise\.all|forEach|loop/i.test(c) },
  ],
  r6: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'abort', check: 'uses AbortController or AbortSignal', test: (c) => /AbortController|AbortSignal|signal/.test(c) },
    { name: 'error_types', check: 'classifies error types', test: (c) => /429|503|rate.*limit|timeout|safety|content.*policy|blocked/i.test(c) },
    { name: 'retry', check: 'retries transient errors', test: (c) => /retry|retries|backoff|Math\.pow|setTimeout/i.test(c) },
    { name: 'safety_no_retry', check: 'does NOT retry safety errors', test: (c) => /safety.*throw|content.*policy.*throw|no.*retry.*safety|blocked.*throw/i.test(c) || /if.*safety|if.*content.*policy|if.*blocked/i.test(c) },
    { name: 'max_3', check: 'limits to ~3 retries', test: (c) => /3|maxRetry|attempt.*3|<= 3|< 3/i.test(c) },
  ],
  r7: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'six_images', check: 'accepts all 6 base64 parameters', test: (c) => /waifuA|waifuB|waifuC|pokemonX|pokemonY|pokemonZ/i.test(c) },
    { name: 'three_characters', check: 'mentions 3 characters in scene', test: (c) => /3.*character|three.*character|waifuA.*waifuB.*waifuC|all.*character/i.test(c) },
    { name: 'costume_fusion_per_character', check: 'each character has costume fusion described', test: (c) => /waifuA.*pokemon|waifuB.*pokemon|waifuC.*pokemon|outfit.*element|costume.*theme/i.test(c) },
    { name: 'scene_interaction', check: 'characters interact in the scene', test: (c) => /playing|interact|together|cafe|café|scene|background/i.test(c) },
    { name: 'preserve_identity', check: 'preserves character identity (face, hair, proportions)', test: (c) => /preserve|keep.*face|keep.*hair|original.*face|body.*proportion|identity/i.test(c) },
    { name: 'not_pokemon_transform', check: 'explicitly says NOT to turn into Pokémon', test: (c) => /not.*turn|not.*become|remain.*human|stay.*human|do not.*transform|wearing.*outfit/i.test(c) },
    { name: 'cafe_setting', check: 'mentions Pokémon café setting', test: (c) => /cafe|café|coffee.*shop|theme.*cafe|cozy/i.test(c) },
    { name: 'parts_ordering', check: 'style refs before character refs in parts array', test: (c) => { const block = c.match(/const\s+parts\s*:\s*Part\[\]\s*=\s*\[[\s\S]*?\];/)?.[0] ?? c; const pokemonIdx = block.search(/pokemonX|pokemonY|pokemonZ/i); const waifuIdx = block.search(/waifuA|waifuB|waifuC/i); return pokemonIdx >= 0 && waifuIdx >= 0 && pokemonIdx < waifuIdx; } },
    { name: 'response_modalities', check: "uses responseModalities: ['TEXT', 'IMAGE']", test: (c) => /responseModalities.*IMAGE/.test(c) },
  ],
};

// ── Runtime Test Configs (from case JSONs) ──────────────────────────────────

const RUNTIME_TESTS: Record<string, RuntimeTestConfig> = {};

// Load runtime test configs from case files (skip malformed JSON)
const casesDir = path.join(__dirname, 'cases');
for (const file of fs.readdirSync(casesDir)) {
  if (!file.endsWith('.json')) continue;
  try {
    const caseData = JSON.parse(fs.readFileSync(path.join(casesDir, file), 'utf-8'));
    if (caseData.runtimeTest) {
      RUNTIME_TESTS[caseData.id.split('-')[0]] = caseData.runtimeTest;
    }
  } catch {
    // Skip malformed case JSON files
  }
}

// ── Runtime Assertions ──────────────────────────────────────────────────────

const RUNTIME_ASSERTIONS: Record<string, RuntimeAssertion[]> = {
  v1: [
    { name: 'at_least_two_calls', check: 'makes at least 2 API calls (judge + generate)', test: (o) => o.calls.length >= 2 },
    { name: 'judge_uses_vision_model', check: 'first call uses vision model (2.5-flash, not image-gen)', test: (o) => {
      const first = o.calls[0];
      if (!first) return false;
      const model = first.params.model ?? '';
      return model.includes('2.5-flash') && !model.includes('image-preview');
    }},
    { name: 'regenerate_uses_image_gen', check: 'second call uses image generation model', test: (o) => {
      const second = o.calls[1];
      if (!second) return false;
      const model = second.params.model ?? '';
      return model.includes('image-preview') || model.includes('imagen') || model.includes('image-gen');
    }},
    { name: 'no_image_config_on_judge', check: 'judge call does not set imageConfig/responseModalities', test: (o) => {
      const first = o.calls[0];
      if (!first) return true; // no call = vacuously true, but at_least_two_calls will fail
      const cfg = first.params.config ?? {};
      return !cfg.imageConfig && (!cfg.responseModalities || cfg.responseModalities.length === 0);
    }},
    { name: 'returns_success', check: 'function returns successfully', test: (o) => o.ok === true },
  ],
  v2: [
    { name: 'uses_streaming', check: 'calls generateContentStream', test: (o) => o.calls.some(c => c.method === 'generateContentStream') },
    { name: 'returns_image', check: 'result contains image base64 string', test: (o) => typeof o.result?.image === 'string' && o.result.image.length > 0 },
    { name: 'returns_progress', check: 'result contains progress array', test: (o) => Array.isArray(o.result?.progress) },
    { name: 'returns_success', check: 'function returns successfully', test: (o) => o.ok === true },
  ],
  v3: [
    { name: 'retries_on_429', check: 'retries after 429 (at least 2 calls)', test: (o) => o.calls.length >= 2 },
    { name: 'returns_success', check: 'eventually succeeds', test: (o) => o.ok === true },
    { name: 'has_backoff_delay', check: 'retry has some delay (>80ms total)', test: (o) => o.elapsed > 80 },
  ],
};

// ── Runtime Test Runner ─────────────────────────────────────────────────────

async function runRuntimeTest(
  codePath: string,
  config: RuntimeTestConfig,
): Promise<RuntimeOutput> {
  const runnerPath = path.resolve(__dirname, 'runtime', 'runner.ts');
  const optsFile = path.join(require('os').tmpdir(), `eval-opts-${Date.now()}.json`);

  const opts = {
    codePath,
    function: config.function,
    args: config.args,
    errorsToQueue: config.errorsToQueue ?? [],
    timeout: 30000,
  };

  fs.writeFileSync(optsFile, JSON.stringify(opts), 'utf-8');

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', runnerPath, optsFile], {
      cwd: __dirname,
      env: process.env,
      timeout: 35000,
      shell: true,
    });

    const chunks: string[] = [];
    proc.stdout.on('data', (chunk) => chunks.push(chunk.toString()));

    proc.on('close', () => {
      try { fs.unlinkSync(optsFile); } catch { /* ignore */ }

      const stdout = chunks.join('');
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));

      if (!jsonLine) {
        resolve({ ok: false, error: 'No JSON output from runner', calls: [], elapsed: 0 });
        return;
      }

      try {
        const parsed = JSON.parse(jsonLine);
        resolve({
          ok: parsed.ok ?? false,
          result: parsed.result,
          error: parsed.error,
          code: parsed.code,
          calls: parsed.calls ?? [],
          elapsed: parsed.elapsed ?? 0,
        });
      } catch {
        resolve({ ok: false, error: 'Failed to parse runner output', calls: [], elapsed: 0 });
      }
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message, calls: [], elapsed: 0 });
    });
  });
}

// ── Grading ─────────────────────────────────────────────────────────────────

const ITERATION = process.argv[2] ?? 'iteration-0';

function gradeStatic(code: string, assertions: StaticAssertion[]): { passed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;
  for (const a of assertions) {
    if (a.name === 'file_exists') { passed++; continue; }
    if (a.test(code)) { passed++; } else { failures.push(`${a.name}: ${a.check}`); }
  }
  return { passed, failures };
}

async function gradeCase(evalId: string, config: 'with_skill' | 'without_skill'): Promise<EvalResult> {
  const outputPath = path.join(
    __dirname,
    ITERATION,
    config.replace('_', '-'),
    evalId,
    'index.ts'
  );

  let code = '';
  try {
    code = fs.readFileSync(outputPath, 'utf-8');
  } catch {
    return {
      evalId,
      config,
      passed: 0,
      total: STATIC_ASSERTIONS[evalId]?.length ?? 0,
      failures: ['file_exists: index.ts not found'],
      outputPath,
    };
  }

  // Static assertions
  const staticAssertions = STATIC_ASSERTIONS[evalId] ?? [];
  const staticResult = gradeStatic(code, staticAssertions);
  let passed = staticResult.passed;
  const failures = [...staticResult.failures];
  let total = staticAssertions.length;

  // Runtime assertions
  const runtimeConfig = RUNTIME_TESTS[evalId];
  const runtimeAssertions = RUNTIME_ASSERTIONS[evalId];
  if (runtimeConfig && runtimeAssertions) {
    const runtimeOutput = await runRuntimeTest(outputPath, runtimeConfig);
    for (const a of runtimeAssertions) {
      total++;
      if (a.test(runtimeOutput)) {
        passed++;
      } else {
        failures.push(`${a.name}: ${a.check}`);
      }
    }
  }

  return { evalId, config, passed, total, failures, outputPath };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const caseMap: Record<string, string[]> = {
    'iteration-0': ['e1', 'e2', 'e3'],
    'iteration-1': ['e4', 'e5', 'e6'],
    'iteration-2': ['e7', 'e8'],
    'iteration-3': ['e9'],
    'iteration-4': ['e11'],
    'real-needs': ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'],
    'real-needs-v2': ['v1', 'v2', 'v3'],
  };

  const cases = caseMap[ITERATION] ?? ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
  const configs: Array<'with_skill' | 'without_skill'> = ['with_skill', 'without_skill'];
  const results: EvalResult[] = [];

  for (const eid of cases) {
    for (const cfg of configs) {
      results.push(await gradeCase(eid, cfg));
    }
  }

  // Summary table
  console.log(`\n=== Evaluation Results — ${ITERATION} ===\n`);
  console.log(`${'Case'.padEnd(6)} ${'Config'.padEnd(14)} ${'Pass'.padEnd(6)} ${'Total'.padEnd(6)} ${'Rate'.padEnd(8)} Failures`);
  console.log('-'.repeat(90));
  for (const r of results) {
    const rate = ((r.passed / r.total) * 100).toFixed(0) + '%';
    const failStr = r.failures.length > 0 ? r.failures.join('; ') : 'none';
    console.log(`${r.evalId.padEnd(6)} ${r.config.padEnd(14)} ${String(r.passed).padEnd(6)} ${String(r.total).padEnd(6)} ${rate.padEnd(8)} ${failStr}`);
  }

  // Aggregate
  const withSkill = results.filter(r => r.config === 'with_skill');
  const withoutSkill = results.filter(r => r.config === 'without_skill');
  const withRate = withSkill.reduce((s, r) => s + r.passed, 0) / withSkill.reduce((s, r) => s + r.total, 0);
  const withoutRate = withoutSkill.reduce((s, r) => s + r.passed, 0) / withoutSkill.reduce((s, r) => s + r.total, 0);

  console.log('\n=== Aggregate ===');
  console.log(`With skill:    ${(withRate * 100).toFixed(1)}%`);
  console.log(`Without skill: ${(withoutRate * 100).toFixed(1)}%`);
  console.log(`Delta:         ${((withRate - withoutRate) * 100).toFixed(1)}%`);

  if (withRate === 1.0) {
    console.log('\n✅ All assertions passed. Awaiting human review...');
  } else {
    console.log('\n⚠️  Some assertions failed. Review failures above.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
