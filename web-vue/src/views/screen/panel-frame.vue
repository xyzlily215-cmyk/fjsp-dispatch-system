<template>
  <section class="panel-frame">
    <span class="corner corner--tl" aria-hidden="true"></span>
    <span class="corner corner--tr" aria-hidden="true"></span>
    <span class="corner corner--bl" aria-hidden="true"></span>
    <span class="corner corner--br" aria-hidden="true"></span>
    <header v-if="title" class="panel-frame__head">
      <i class="panel-frame__diamond" aria-hidden="true"></i>
      <h2>{{ title }}</h2>
      <div class="panel-frame__extra">
        <slot name="extra" />
        <span v-if="tag" class="panel-frame__tag">{{ tag }}</span>
      </div>
    </header>
    <div class="panel-frame__body">
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  /* 标题右侧的迷你标签，如「实时」「日」 */
  tag: { type: String, default: '' },
});
</script>

<style scoped>
.panel-frame {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: linear-gradient(180deg, rgba(9, 38, 84, 0.82), rgba(3, 16, 40, 0.92));
  border: 1px solid rgba(64, 166, 255, 0.34);
  box-shadow: inset 0 0 34px rgba(0, 110, 220, 0.1), 0 6px 22px rgba(0, 8, 30, 0.4);
}

.corner {
  position: absolute;
  width: 15px;
  height: 15px;
  border: 2px solid #2ce8ff;
  filter: drop-shadow(0 0 5px rgba(44, 232, 255, 0.7));
  pointer-events: none;
}

.corner--tl { top: -1px; left: -1px; border-right: none; border-bottom: none; }
.corner--tr { top: -1px; right: -1px; border-left: none; border-bottom: none; }
.corner--bl { bottom: -1px; left: -1px; border-right: none; border-top: none; }
.corner--br { bottom: -1px; right: -1px; border-left: none; border-top: none; }

.panel-frame__head {
  flex: 0 0 38px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  background: linear-gradient(90deg, rgba(22, 96, 180, 0.5), rgba(10, 44, 95, 0.08));
  border-bottom: 1px solid rgba(60, 160, 255, 0.22);
}

.panel-frame__head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #dff2ff;
  letter-spacing: 1.5px;
  white-space: nowrap;
}

.panel-frame__diamond {
  width: 9px;
  height: 9px;
  background: #2ce8ff;
  transform: rotate(45deg);
  box-shadow: 0 0 9px #2ce8ff;
  flex-shrink: 0;
  position: relative;
}

.panel-frame__diamond::after {
  content: "";
  position: absolute;
  inset: 3px;
  background: #04142e;
}

.panel-frame__extra {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.panel-frame__tag {
  font-size: 10px;
  padding: 3px 9px;
  color: #fff;
  background: linear-gradient(180deg, #1b7ede, #0d4c9c);
  border: 1px solid #46b6ff;
  box-shadow: 0 0 10px rgba(45, 160, 255, 0.45);
  white-space: nowrap;
}

.panel-frame__body {
  flex: 1;
  min-height: 0;
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
}
</style>
