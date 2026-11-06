'use client'

import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

interface ChangeAmountProps extends ComponentProps<'span'> {
  /** Positive for a rise, negative for a fall. Zero shows `No change`. */
  change: number
}

function ChangeAmount({ change, children, className, ...props }: ChangeAmountProps) {
  if (change === 0) {
    return (
      <span data-slot='change-amount' className={className} {...props}>
        No change
      </span>
    )
  }

  return (
    <span
      data-slot='change-amount'
      className={cn(
        'inline-flex items-baseline gap-0.5 [&_svg]:size-3.5 [&_svg]:self-center',
        className,
      )}
      {...props}
    >
      {change > 0 ? (
        <ArrowUpIcon aria-hidden />
      ) : (
        <ArrowDownIcon aria-hidden />
      )}
      <span className='sr-only'>{change > 0 ? 'Up' : 'Down'} </span>
      {children}
    </span>
  )
}

export { ChangeAmount }
export type { ChangeAmountProps }
