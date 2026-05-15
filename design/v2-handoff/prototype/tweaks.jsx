// ── V2 Tweaks: polish controls ────────────────────────────────────────────────

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "background": "aurora",
  "density": "compact",
  "motion": "expressive",
  "stage": "scan",
  "surface": "glass",
  "accent": "indigo",
  "heroScale": 1.0
}/*EDITMODE-END*/;

function applyTweaks(t) {
  const b = document.body;
  b.setAttribute('data-af-bg', t.background);
  b.setAttribute('data-af-density', t.density);
  b.setAttribute('data-af-motion', t.motion);
  b.setAttribute('data-af-stage', t.stage);
  b.setAttribute('data-af-surface', t.surface);
  b.setAttribute('data-af-accent', typeof t.accent === 'string' ? t.accent : 'indigo');
  b.style.setProperty('--af-hero-scale', t.heroScale);
}

const ACCENT_SWATCHES = {
  indigo:  { stops: ['#6366f1', '#a855f7'] },
  emerald: { stops: ['#10b981', '#06b6d4'] },
  amber:   { stops: ['#f59e0b', '#ef4444'] },
  rose:    { stops: ['#ec4899', '#a855f7'] },
};

function AFTweaksPanel() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => { applyTweaks(t); }, [t]);

  // Custom accent control using simple buttons so the value stays a string
  function AccentPicker() {
    const keys = Object.keys(ACCENT_SWATCHES);
    return (
      <div className="twk-row">
        <div className="twk-lbl"><span>Accent</span><span className="twk-val">{t.accent}</span></div>
        <div style={{ display: 'flex', gap: 6 }}>
          {keys.map(k => {
            const sw = ACCENT_SWATCHES[k];
            const active = t.accent === k;
            return (
              <button key={k} onClick={() => setTweak('accent', k)} title={k}
                style={{
                  flex: 1, height: 30, borderRadius: 6, cursor: 'pointer',
                  background: `linear-gradient(135deg, ${sw.stops[0]}, ${sw.stops[1]})`,
                  border: `2px solid ${active ? 'rgba(41,38,27,0.85)' : 'transparent'}`,
                  outline: active ? '1px solid rgba(255,255,255,0.6)' : 'none',
                  outlineOffset: -3,
                  padding: 0,
                  boxShadow: active ? '0 0 0 1px rgba(0,0,0,0.1)' : 'none',
                  transition: 'all 150ms ease',
                }}/>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <TweaksPanel title="V2 Polish">
      <TweakSection label="Visual" />
      <TweakRadio   label="Background" value={t.background}
        options={['solid', 'grid', 'aurora']}
        onChange={v => setTweak('background', v)} />
      <TweakRadio   label="Surface"    value={t.surface}
        options={['flat', 'soft', 'glass']}
        onChange={v => setTweak('surface', v)} />
      <AccentPicker />

      <TweakSection label="Density & Type" />
      <TweakRadio  label="Density"    value={t.density}
        options={['cozy', 'standard', 'compact']}
        onChange={v => setTweak('density', v)} />
      <TweakSlider label="Hero scale" value={t.heroScale}
        min={0.85} max={1.35} step={0.05}
        onChange={v => setTweak('heroScale', v)} />

      <TweakSection label="Motion" />
      <TweakRadio  label="Intensity"  value={t.motion}
        options={['quiet', 'standard', 'expressive']}
        onChange={v => setTweak('motion', v)} />
      <TweakRadio  label="Active stage" value={t.stage}
        options={['flow', 'scan', 'static']}
        onChange={v => setTweak('stage', v)} />
    </TweaksPanel>
  );
}

// Apply on first load before React mounts (so flash-of-default is minimal)
applyTweaks(TWEAK_DEFAULTS);

Object.assign(window, { AFTweaksPanel, TWEAK_DEFAULTS, applyTweaks });
