<script>
	const features = ['Select', 'Edit', 'Reorder'];
	let count = $state(0);
</script>

<section class="card">
	<h2>This heading is a Svelte component</h2>
	<p>The editor cannot index this yet. See the note in the README.</p>
	<ul>
		{#each features as feature}
			<li>{feature}</li>
		{/each}
	</ul>
	<button type="button" onclick={() => count++}>Clicked {count} times</button>
</section>
