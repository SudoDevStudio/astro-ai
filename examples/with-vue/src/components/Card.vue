<script setup>
import { ref } from 'vue';

const features = ['Select', 'Edit', 'Reorder'];
const count = ref(0);
</script>

<template>
  <section class="card">
    <h2>This heading is a Vue single-file component</h2>
    <p>The editor cannot index this yet. See the note in the README.</p>
    <ul>
      <li v-for="feature in features" :key="feature">{{ feature }}</li>
    </ul>
    <button type="button" @click="count++">Clicked {{ count }} times</button>
  </section>
</template>
