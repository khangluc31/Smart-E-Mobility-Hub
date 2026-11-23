// Header notification bell with 5s polling unread badge and popover list (FR-62, T-10).
// Fits 360px mobile viewports (`w-80 max-w-[calc(100vw-1.5rem)]`).

import { Bell, CheckCheck } from 'lucide-react';
import {
  useMarkAllRead,
  useMarkRead,
  useNotifications,
} from '@/hooks/useNotifications';
import { ErrorBox } from '@/components/common/ErrorBox';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Notification } from '@/types/notifications';

export const BELL_NOTIFICATION_LIMIT = 20;

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.round(diffHr / 24);
  return `${diffDays}d ago`;
}

export function NotificationBell() {
  const { data, isLoading, isError, error } = useNotifications({
    limit: BELL_NOTIFICATION_LIMIT,
  });
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  const unreadCount = data?.unreadCount ?? 0;
  const items = data?.items ?? [];
  const mutationError = markRead.isError
    ? markRead.error
    : markAllRead.isError
      ? markAllRead.error
      : null;

  function handleItemClick(item: Notification) {
    if (item.readAt === null && !markRead.isPending) {
      markRead.mutate(item.id);
    }
  }

  function handleMarkAllRead() {
    if (unreadCount > 0 && !markAllRead.isPending) {
      markAllRead.mutate();
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="relative"
          aria-label={
            unreadCount > 0
              ? `Notifications (${unreadCount} unread)`
              : 'Notifications'
          }
        >
          <Bell className="h-3.5 w-3.5" />
          {unreadCount > 0 && (
            <span
              data-testid="notification-unread-badge"
              className="ml-1 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-destructive px-1.5 py-0.2 text-[10px] font-semibold leading-4 text-white"
            >
              {unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-1.5rem)] p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <span className="text-xs text-muted-foreground">
                ({unreadCount} unread)
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={unreadCount === 0 || markAllRead.isPending}
            onClick={handleMarkAllRead}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            <span>Mark all read</span>
          </Button>
        </div>

        {Boolean(isError || mutationError) && (
          <div className="p-2.5 border-b">
            <ErrorBox
              error={isError ? error : mutationError}
              title="Notifications error"
            />
          </div>
        )}

        <div className="max-h-80 overflow-y-auto divide-y">
          {isLoading && items.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              Loading notifications…
            </p>
          ) : items.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              No notifications
            </p>
          ) : (
            items.map((item) => {
              const isUnread = item.readAt === null;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleItemClick(item)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 transition-colors hover:bg-accent/60 focus:outline-none focus:bg-accent',
                    isUnread ? 'bg-primary/5' : 'bg-transparent',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isUnread && (
                        <span
                          aria-label="Unread"
                          className="h-2 w-2 shrink-0 rounded-full bg-primary"
                        />
                      )}
                      <span
                        className={cn(
                          'text-xs truncate',
                          isUnread ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
                        )}
                      >
                        {item.title}
                      </span>
                    </div>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatRelativeTime(item.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground break-words">
                    {item.body}
                  </p>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
