import { useState, type ReactNode } from 'react';

export function SiteIcon({ url, className, children }: {
  url: string | null;
  className: string;
  children: ReactNode;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <div className={`overflow-hidden ${className}`} aria-hidden="true">
      {url && failedUrl !== url ? (
        <img src={url} alt="" className="h-full w-full object-contain" onError={() => setFailedUrl(url)} />
      ) : children}
    </div>
  );
}
