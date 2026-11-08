import { IconPackages, IconBuildingBank, IconChartLine, IconCurrencyDollar, IconCalendarStats } from '@tabler/icons-react';

/** Service identity stays independent of connection health and the selected palette. */
export default function ServiceIcon({kind}:{kind:string}) {
  if (kind === 'postgresql' || kind === 'redis') return <span className="service-icon" data-kind={kind} aria-hidden="true"><img src={`/fire-assets/brands/${kind}.${kind === 'redis' ? 'png' : 'svg'}`} alt="" width={24} height={24}/></span>;
  const icons:Record<string,typeof IconPackages>={worker:IconPackages,broker:IconBuildingBank,quotes:IconChartLine,fx:IconCurrencyDollar,earnings:IconCalendarStats};
  const Icon=icons[kind] || IconChartLine;
  return <span className="service-icon" data-kind={kind} aria-hidden="true"><Icon size={24} stroke={1.7}/></span>;
}
