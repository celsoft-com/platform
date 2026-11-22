<!-- Service Dark ColorPicker: choose any color, start from a suggestion, or pick at random. Stores #rrggbb. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Button from './Button.svelte';
  import { colorStyle, colorName, randomColor, seedColor } from '../lib/colors.js';

  interface Props {
    /** Bindable. The chosen color as #rrggbb, or null for none yet. Validate it with UserColor. */
    value?: string | null;
    label?: string;
    /** How many quick suggestions to show; they spread by the golden angle so they differ the most. */
    suggestions?: number;
    /** Show a Random button. */
    random?: boolean;
    /** Colors already used nearby, such as by sibling projects; Random moves its hue away from them. */
    avoid?: string[];
    disabled?: boolean;
    onchange?: (value: string) => void;
  }

  let { value = $bindable(null), label = 'Color', suggestions = 10, random = true, avoid = [], disabled = false, onchange }: Props = $props();

  const uid = $props.id();
  const quick = $derived(Array.from({ length: suggestions }, (_, i) => seedColor(i + 1)));
  const custom = $derived(value != null && !quick.includes(value));
  let swatches = $state<HTMLElement>();

  function choose(c: string, focus = false) {
    if (disabled) return;
    value = c;
    onchange?.(c);
    if (focus) swatches?.querySelector<HTMLElement>(`[data-color="${c}"]`)?.focus();
  }

  // Radio-group keys over the suggestions: arrows move and choose, Home and End jump to the ends.
  function keys(e: KeyboardEvent) {
    if ((e.target as HTMLElement).matches('input')) return;
    const i = value ? quick.indexOf(value) : -1;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next: number | undefined;
    if (step) next = (Math.max(i, step > 0 ? -1 : 0) + step + quick.length) % quick.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = quick.length - 1;
    if (next == null) return;
    e.preventDefault();
    choose(quick[next], true);
  }
</script>

<div class="sd-field">
  <span class="sd-field-label" id="sd-color-{uid}">{label}</span>
  <div class="sd-colorpicker">
    <div class="sd-swatches" role="radiogroup" aria-labelledby="sd-color-{uid}" tabindex="-1" bind:this={swatches} onkeydown={keys}>
      {#each quick as c, i (c)}
        <button
          type="button"
          role="radio"
          class="sd-swatch sd-cat"
          data-color={c}
          style={colorStyle({ color: c })}
          aria-checked={value === c}
          aria-label={colorName(c)}
          title={colorName(c)}
          tabindex={value === c || (!quick.includes(value ?? '') && i === 0) ? 0 : -1}
          {disabled}
          onclick={() => choose(c)}
        >{#if value === c}<Icon name="check" />{/if}</button>
      {/each}
      <label class={['sd-swatch', 'sd-swatch-custom', custom && 'sd-cat']} style={custom && value ? colorStyle({ color: value }) : undefined} title="Any color">
        <input class="sd-sr" type="color" aria-label="Any color" value={value ?? '#7c6cf0'} {disabled} oninput={(e) => choose(e.currentTarget.value)} />
        {#if custom}<Icon name="check" />{:else}<Icon name="plus" />{/if}
      </label>
    </div>
    {#if random}
      <Button variant="quiet" size="sm" icon="shuffle" {disabled} onclick={() => choose(randomColor({ avoid: [...avoid, ...(value ? [value] : [])] }))}>Random</Button>
    {/if}
  </div>
  {#if value}<span class="sd-field-hint">{colorName(value)} <span class="mono-sm">{value}</span>, shown fitted to the palette</span>{/if}
</div>
