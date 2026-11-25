import type { MediaExecutor } from './media-execution.ts';
import { executeBasic } from './plans/basic.ts';
import { renderComposition } from './plans/composition.ts';
import { executeDerivatives } from './plans/derivatives.ts';
import { renderMix } from './plans/mix.ts';
import { renderNarration } from './plans/narration.ts';
import { renderSubtitleCommand } from './plans/subtitles.ts';
import { executeTrim } from './plans/trim.ts';

export const executeMedia: MediaExecutor = (command, context) => {
  switch (command.operation) {
    case 'video.derivatives':
      return executeDerivatives(command, context);
    case 'video.trim':
      return executeTrim(command, context);
    case 'composition.render':
      return renderComposition(command, context);
    case 'video.mix':
      return renderMix(command, context);
    case 'video.narration_render':
      return renderNarration(command, context);
    case 'subtitle.burn':
      return renderSubtitleCommand(command, context);
    default:
      return executeBasic(command, context);
  }
};
