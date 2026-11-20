import { ProductPageView, productPageMetadata } from '@/components/site/ProductPageView';
import { TEAMS } from '@/site/product-pages';

export const dynamic = 'force-static';

export const metadata = productPageMetadata(TEAMS);

export default function TeamsPage() {
  return <ProductPageView page={TEAMS} />;
}
