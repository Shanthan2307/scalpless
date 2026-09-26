'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { suiscanObject } from './actions';

export function SectionHeader({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-10">
      <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#6B6B6B] mb-2">{kicker}</div>
      <h2 className="font-serif text-3xl md:text-4xl font-normal tracking-tight">{title}</h2>
      {children && <p className="text-[16px] text-[#6B6B6B] mt-2 max-w-[760px]">{children}</p>}
    </div>
  );
}

export function Panel({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`border border-[#E5E5E0] bg-white p-6 ${className}`}>
      {title && <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#6B6B6B] mb-4">{title}</div>}
      {children}
    </div>
  );
}

export function Btn({ variant = 'solid', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'solid' | 'outline' | 'danger' }) {
  const styles = {
    solid: 'bg-[#111111] text-[#FAFAF7] border-[#111111] hover:bg-transparent hover:text-[#111111]',
    outline: 'bg-transparent text-[#111111] border-[#111111] hover:bg-[#111111] hover:text-[#FAFAF7]',
    danger: 'bg-transparent text-red-800 border-red-300 hover:bg-red-50',
  }[variant];
  return (
    <button
      {...props}
      className={`px-4 py-2 text-[11px] font-mono uppercase tracking-[0.1em] border transition-all disabled:opacity-40 disabled:pointer-events-none ${styles} ${className}`}
    />
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-[0.1em] text-[#6B6B6B]">{label}</div>
      <div className="font-serif text-2xl mt-1">{value}</div>
      {sub && <div className="text-[11px] font-mono text-[#6B6B6B] mt-1">{sub}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-mono uppercase tracking-[0.1em] text-[#6B6B6B]">
      {label}
      {children}
    </label>
  );
}

export const inputCls = 'border border-[#E5E5E0] bg-[#FAFAF7] px-3 py-2 text-[13px] font-mono text-[#111111] normal-case tracking-normal focus:outline-none focus:border-[#111111]';

export function ObjLink({ id, label }: { id: string; label?: string }) {
  return (
    <a href={suiscanObject(id)} target="_blank" rel="noreferrer" className="underline text-[#1D3557]">
      {label ?? `${id.slice(0, 8)}…${id.slice(-4)}`}
    </a>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-[13px] font-mono text-[#6B6B6B] py-4">{children}</div>;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  const cls = tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-[#E5E5E0] bg-[#FAFAF7] text-[#111111]';
  return <div className={`border p-4 text-[12px] font-mono ${cls}`}>{children}</div>;
}
