<template>
  <nav>
    <b>Chat Marine</b>
  </nav>

  <main v-if="data">
    <section>
      <h1>{{ data.hero.title }}</h1>
      <p>{{ data.hero.subtitle }}</p>
    </section>

    <section>
      <h2>News</h2>
      <div class="news-item" v-for="n in data.news" :key="n.id">
        <span>{{ n.title }}</span>
        <span class="date">{{ n.date }}</span>
      </div>
    </section>

    <section>
      <h2>Feed</h2>
      <div class="feed-card" v-for="f in data.feed" :key="f.id">
        <h3>{{ f.title }}</h3>
        <p>{{ f.body }}</p>
        <span class="tag">{{ f.tag }}</span>
      </div>
    </section>
  </main>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const data = ref(null)

onMounted(async () => {
  const res = await fetch('/data.json')
  data.value = await res.json()
})
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: monospace; background: #fff; color: #111; }

nav { border-bottom: 1px solid #ccc; padding: 12px 24px; }

main { max-width: 680px; margin: 0 auto; padding: 40px 24px; }
section { margin-bottom: 48px; }

h1 { font-size: 24px; margin-bottom: 6px; }
h2 { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #999;
     border-bottom: 1px solid #eee; padding-bottom: 8px; margin-bottom: 16px; }
p  { font-size: 13px; color: #666; line-height: 1.8; }

.news-item { display: flex; justify-content: space-between; padding: 10px 0;
             border-bottom: 1px solid #f0f0f0; font-size: 13px; }
.date { color: #aaa; white-space: nowrap; margin-left: 16px; }

.feed-card { border: 1px solid #e0e0e0; padding: 14px; margin-bottom: 10px; }
.feed-card h3 { font-size: 13px; margin-bottom: 4px; }
.feed-card p  { font-size: 12px; color: #777; margin: 0; }
.tag { font-size: 10px; background: #111; color: #fff;
       padding: 2px 6px; margin-top: 8px; display: inline-block; }
</style>
