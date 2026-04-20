import * as fs from 'fs';
import * as path from 'path';

interface Assertion {
  name: string;
  check: string;
  test: (code: string) => boolean;
}

interface EvalResult {
  evalId: string;
  config: 'with_skill' | 'without_skill';
  passed: number;
  total: number;
  failures: string[];
  outputPath: string;
}

const ASSERTIONS: Record<string, Assertion[]> = {
  e1: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true /* checked before */ },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_google_genai_constructor', check: "contains 'new GoogleGenAI'", test: (c) => /new\s+GoogleGenAI/.test(c) },
    { name: 'response_modalities_set', check: 'contains responseModalities with IMAGE', test: (c) => /responseModalities.*IMAGE/.test(c) },
    { name: 'parts_array_constructed', check: 'uses parts or Part[] to assemble inputs', test: (c) => /parts\s*:/.test(c) || /Part\[\]/.test(c) },
    { name: 'extracts_inline_data', check: 'accesses .inlineData.data for base64 output', test: (c) => /inlineData\.?data/.test(c) },
    { name: 'handles_thought_signature', check: 'references thoughtSignature', test: (c) => /thoughtSignature/.test(c) },
    // Discriminating: skill teaches style ref BEFORE subject (parts ordering)
    { name: 'style_before_subject', check: 'style reference image appears before subject image in parts array', test: (c) => {
      // Extract only the parts array block to avoid matching function signatures
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
    // Discriminating: skill teaches degradation fallback when thoughtSignature is missing
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
    // Discriminating: skill teaches nested scores structure (laaj.md schema)
    { name: 'nested_scores_object', check: 'EvaluationResult uses nested scores: { scores: { dimension: number } }', test: (c) => /scores\s*:\s*\{[\s\S]{0,200}subject_fidelity|scores\s*:\s*Record/.test(c) },
    // Discriminating: skill uses GEMINI_API_KEY env var
    { name: 'uses_gemini_api_key', check: 'uses GEMINI_API_KEY (not GOOGLE_API_KEY)', test: (c) => /GEMINI_API_KEY/.test(c) },
  ],
  e4: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'imports_genai', check: "contains '@google/genai' import", test: (c) => c.includes("@google/genai") },
    { name: 'uses_files_upload', check: 'uses ai.files.upload()', test: (c) => /files\.upload/.test(c) },
    { name: 'uses_createPartFromUri', check: 'uses createPartFromUri()', test: (c) => /createPartFromUri/.test(c) },
    { name: 'handles_403_fallback', check: 'has 403 or fallback to inlineData logic', test: (c) => /403|fallback|inlineData.*catch|catch.*inlineData/.test(c) },
    { name: 'returns_image_base64', check: 'extracts and returns generated image base64', test: (c) => /inlineData\??\.data/.test(c) },
    // Discriminating: skill teaches 47h TTL awareness
    { name: 'mentions_ttl_or_cache', check: 'mentions cache duration or TTL', test: (c) => /ttl|TTL|cache|47|expir/.test(c) },
  ],
  e5: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'uses_pic_n_regex', check: 'uses regex to match [pic_N] tokens', test: (c) => /\\\[pic_\\d+\\\]|\[pic_/.test(c) },
    { name: 'returns_part_array', check: 'returns Part[]', test: (c) => /Part\[\]/.test(c) },
    { name: 'alternates_text_and_images', check: 'produces alternating text/image sequence', test: (c) => /text.*push|push.*text/.test(c) && /push.*imagePart|imagePart.*push/.test(c) },
    { name: 'handles_missing_refs', check: 'handles missing pic references gracefully (keeps token as text)', test: (c) => /else\s*\{[\s\S]{0,100}text.*token|token.*text/.test(c) || /\{\s*text\s*:\s*token/.test(c) },
    // Discriminating: skill uses Map<number, Part> parameter type
    { name: 'uses_map_param', check: 'uses Map<number, Part> for picMap', test: (c) => /Map\s*<\s*number\s*,\s*Part\s*>/.test(c) },
  ],
  e6: [
    { name: 'file_exists', check: 'index.ts exists', test: (_c) => true },
    { name: 'uses_abort_controller', check: 'creates AbortController', test: (c) => /AbortController/.test(c) },
    { name: 'has_timeout', check: 'has setTimeout for abort', test: (c) => /setTimeout.*abort|30000/.test(c) },
    { name: 'classifies_errors', check: 'classifies into RATE_LIMIT/TIMEOUT/CONTENT_POLICY', test: (c) => /RATE_LIMIT|TIMEOUT|CONTENT_POLICY/.test(c) },
    { name: 'has_retry_logic', check: 'has exponential backoff retry', test: (c) => /retry|retries|backoff|Math\.pow/.test(c) },
    { name: 'content_policy_no_retry', check: 'CONTENT_POLICY throws without retry', test: (c) => /CONTENT_POLICY/.test(c) && (/throw/.test(c) || /continue/.test(c)) },
    // Discriminating: skill passes signal to generateContent
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
};

const ITERATION = process.argv[2] ?? 'iteration-0';

function gradeCase(evalId: string, config: 'with_skill' | 'without_skill'): EvalResult {
  const outputPath = path.join(
    'C:\\Users\\池雪琴\\.agents\\skills\\gemini-imagen-patterns\\eval',
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
      total: ASSERTIONS[evalId].length,
      failures: ['file_exists: index.ts not found'],
      outputPath,
    };
  }

  const assertions = ASSERTIONS[evalId];
  const failures: string[] = [];
  let passed = 0;

  for (const a of assertions) {
    if (a.name === 'file_exists') {
      passed++;
      continue;
    }
    if (a.test(code)) {
      passed++;
    } else {
      failures.push(`${a.name}: ${a.check}`);
    }
  }

  return { evalId, config, passed, total: assertions.length, failures, outputPath };
}

function main() {
  const cases = ITERATION === 'iteration-0'
    ? ['e1', 'e2', 'e3']
    : ITERATION === 'iteration-1'
    ? ['e4', 'e5', 'e6']
    : ITERATION === 'iteration-2'
    ? ['e7', 'e8']
    : ITERATION === 'iteration-3'
    ? ['e9']
    : ['e11'];
  const configs: Array<'with_skill' | 'without_skill'> = ['with_skill', 'without_skill'];
  const results: EvalResult[] = [];

  for (const eid of cases) {
    for (const cfg of configs) {
      results.push(gradeCase(eid, cfg));
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

main();
