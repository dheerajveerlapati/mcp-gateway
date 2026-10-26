import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import type * as React from 'react'
import { cn } from '@/lib/utils'

const Collapsible = CollapsiblePrimitive.Root
const CollapsibleTrigger = CollapsiblePrimitive.Trigger
const CollapsibleContent = CollapsiblePrimitive.Content

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-md bg-accent', className)} {...props} />
}

function Separator({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="separator" role="separator" className={cn('h-px w-full shrink-0 bg-border', className)} {...props} />
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger, Separator, Skeleton }
