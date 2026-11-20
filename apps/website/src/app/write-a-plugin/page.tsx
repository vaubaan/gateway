import { ProductPageView, productPageMetadata } from '@/components/site/ProductPageView';
import { WRITE_A_PLUGIN } from '@/site/product-pages';

export const dynamic = 'force-static';

export const metadata = productPageMetadata(WRITE_A_PLUGIN);

export default function WriteAPluginPage() {
  return <ProductPageView page={WRITE_A_PLUGIN} />;
}
