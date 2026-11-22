interface QualityWeights {
  titleDesc: number;
  photos: number;
  requiredAttrs: number;
  optionalAttrs: number;
  location: number;
  video: number;
  price: number;
}

interface QualityInput {
  title: string;
  description: string;
  mediaCount: number;
  hasVideo: boolean;
  price: unknown;
  lat: unknown;
  dynamicAttributes: Record<string, unknown>;
  requiredKeys: string[];
  optionalKeys: string[];
}

export function computeQuality(input: QualityInput, weights: QualityWeights): number {
  let score = 0;

  // Title + description (combined length heuristic)
  const textLen = (input.title?.length ?? 0) + (input.description?.length ?? 0);
  const textScore = Math.min(1, textLen / 200);
  score += textScore * weights.titleDesc;

  // Photos (max 10)
  const photoScore = Math.min(1, input.mediaCount / 5);
  score += photoScore * weights.photos;

  // Required attributes filled
  const reqFilled = input.requiredKeys.filter((k) => input.dynamicAttributes[k] !== undefined && input.dynamicAttributes[k] !== '').length;
  const reqScore = input.requiredKeys.length > 0 ? reqFilled / input.requiredKeys.length : 1;
  score += reqScore * weights.requiredAttrs;

  // Optional attributes filled
  const optFilled = input.optionalKeys.filter((k) => input.dynamicAttributes[k] !== undefined && input.dynamicAttributes[k] !== '').length;
  const optScore = input.optionalKeys.length > 0 ? optFilled / input.optionalKeys.length : 0;
  score += optScore * weights.optionalAttrs;

  // Location
  score += (input.lat !== null && input.lat !== undefined ? 1 : 0) * weights.location;

  // Video
  score += (input.hasVideo ? 1 : 0) * weights.video;

  // Price
  score += (input.price !== null && input.price !== undefined ? 1 : 0) * weights.price;

  return Math.round(Math.min(100, score));
}
