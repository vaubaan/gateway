import { ProductPageView, productPageMetadata } from '@/components/site/ProductPageView';
import { HOW_IT_WORKS } from '@/site/product-pages';

export const dynamic = 'force-static';

export const metadata = productPageMetadata(HOW_IT_WORKS);

export default function HowItWorksPage() {
  return <ProductPageView page={HOW_IT_WORKS} />;
}
