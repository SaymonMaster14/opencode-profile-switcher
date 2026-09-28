const marker = process.argv[2]
if (!marker || !/^[A-Z0-9_]+$/.test(marker)) process.exit(2)
console.log(marker)
