import { Construction } from 'lucide-react';
import { PageHeader } from '@/components/app-shell/page-header';
import { Badge } from '@/components/ui/badge';
import { findNavItem } from '@/lib/navigation';

/** Placeholder for routes whose backing module exists but has no behaviour yet. */
export function NotImplemented({ href }: { href: string }) {
  const item = findNavItem(href);
  if (!item) throw new Error(`No navigation entry for ${href}`);

  return (
    <>
      <PageHeader
        title={item.label}
        description={item.description}
        actions={<Badge variant="outline">Not implemented</Badge>}
      />
      <div className="p-8">
        <div className="flex max-w-xl items-start gap-3 rounded-lg border border-dashed bg-card p-5">
          <Construction className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">The module foundation exists, but no functionality yet.</p>
            <p className="mt-1 text-muted-foreground">
              The API module is registered and the data model will be designed before any behaviour
              is added. See <code className="font-mono text-xs">docs/architecture.md</code>.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
