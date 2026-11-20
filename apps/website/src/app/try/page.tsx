import { ProductPageView, productPageMetadata } from '@/components/site/ProductPageView';
import { TRY_PAGE } from '@/site/product-pages';

export const dynamic = 'force-static';

export const metadata = productPageMetadata(TRY_PAGE);

export default function TryPage() {
  return <ProductPageView page={TRY_PAGE} />;
}
