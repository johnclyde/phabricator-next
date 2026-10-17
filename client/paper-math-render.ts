import katex from 'katex';
import { PAPER_PREVIEW_MAX_MATH_CHARACTERS } from '../shared/paper-preview';

export interface PaperMathRequest { expression: string; displayMode: boolean }
export interface PaperMathResult { html: string | null }
export interface PaperMathRendering { results: PaperMathResult[]; limited: boolean; failed: number }
export const PAPER_MATH_MARKUP_BUDGET = 1_000_000;
export const PAPER_MATH_INPUT_BUDGET = 24_000;

/** Runs in a disposable worker. The source and resulting markup never leave the device. */
export function renderPaperMath(requests: PaperMathRequest[]): PaperMathRendering {
  const macros = Object.create(null) as NonNullable<katex.KatexOptions['macros']>;
  let remainingMarkup = PAPER_MATH_MARKUP_BUDGET, remainingInput = PAPER_MATH_INPUT_BUDGET;
  let limited = false, failed = 0;
  const results = requests.map((request, index): PaperMathResult => {
    if (index >= 300 || request.expression.length > PAPER_PREVIEW_MAX_MATH_CHARACTERS || request.expression.length > remainingInput || remainingMarkup <= 0) {
      limited = true;
      return { html: null };
    }
    remainingInput -= request.expression.length;
    try {
      const nextMacros = { ...macros };
      const html = katex.renderToString(request.expression, {
        displayMode: request.displayMode, output: 'htmlAndMathml', trust: false, throwOnError: true,
        strict: 'error', maxExpand: 256, maxSize: 20, macros: nextMacros,
      });
      if (html.length > remainingMarkup) { limited = true; remainingMarkup = 0; return { html: null }; }
      remainingMarkup -= html.length;
      Object.assign(macros, nextMacros);
      return { html };
    } catch {
      failed++;
      return { html: null };
    }
  });
  return { results, limited, failed };
}
