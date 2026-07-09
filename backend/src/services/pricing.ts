// NOTE: model-pricing.json 是自动生成的，唯一真实来源在 shared/model-pricing.json
// 修改定价请编辑 shared/model-pricing.json，然后运行 npm run build 或 node scripts/sync-shared.js
import pricingData from '../data/model-pricing.json';

export function estimateNeurons(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens?: number
): number {
  promptTokens = promptTokens || 0;
  completionTokens = completionTokens || 0;
  const cached = cachedTokens || 0;
  const rate = pricingData.models[model as keyof typeof pricingData.models] ?? pricingData.default;
  const normalInput = Math.max(0, promptTokens - cached);
  const cachedInputRate = (rate as any).cachedInput ?? rate.input;
  const neurons = (normalInput / 1000) * rate.input
                + (cached / 1000) * cachedInputRate
                + (completionTokens / 1000) * rate.output;
  return Math.max(1, Math.round(neurons));
}
