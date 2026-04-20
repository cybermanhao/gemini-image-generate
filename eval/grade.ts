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
};

function gradeCase(evalId: string, config: 'with_skill' | 'without_skill'): EvalResult {
  const outputPath = path.join(
    'C:\\Users\\池雪琴\\.agents\\skills\\gemini-imagen-patterns\\eval\\iteration-0',
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
  const cases = ['e1', 'e2', 'e3'];
  const configs: Array<'with_skill' | 'without_skill'> = ['with_skill', 'without_skill'];
  const results: EvalResult[] = [];

  for (const eid of cases) {
    for (const cfg of configs) {
      results.push(gradeCase(eid, cfg));
    }
  }

  // Summary table
  console.log('\n=== Evaluation Results ===\n');
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
