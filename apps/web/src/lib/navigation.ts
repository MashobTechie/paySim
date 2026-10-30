import {
  Activity,
  FileText,
  FlaskConical,
  LayoutDashboard,
  type LucideIcon,
  Receipt,
  RotateCcw,
  Zap,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
  {
    title: 'Overview',
    items: [
      {
        href: '/',
        label: 'Dashboard',
        icon: LayoutDashboard,
        description: 'System status and foundation progress.',
      },
    ],
  },
  {
    title: 'Simulate',
    items: [
      {
        href: '/payments',
        label: 'Payments',
        icon: Receipt,
        description: 'Create synthetic insurance payments and follow them through their lifecycle.',
      },
      {
        href: '/claims',
        label: 'Claims',
        icon: FileText,
        description: 'Synthetic claims that originate payouts and premium collections.',
      },
      {
        href: '/events',
        label: 'Events',
        icon: Activity,
        description: 'Inspect the append-only event stream and simulated webhook deliveries.',
      },
    ],
  },
  {
    title: 'Reliability',
    items: [
      {
        href: '/failure-injection',
        label: 'Failure injection',
        icon: Zap,
        description: 'Inject timeouts, duplicate deliveries and out-of-order events.',
      },
      {
        href: '/replay',
        label: 'Replay',
        icon: RotateCcw,
        description: 'Re-run recorded scenarios without mutating the original payment records.',
      },
      {
        href: '/test-runs',
        label: 'Test runs',
        icon: FlaskConical,
        description: 'Automated scenario runs with assertions and regression history.',
      },
    ],
  },
];

export function findNavItem(href: string): NavItem | undefined {
  return NAVIGATION.flatMap((section) => section.items).find((item) => item.href === href);
}
