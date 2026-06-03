import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const key = process.env.APOLLO_API_KEY;
  console.log('Key:', key?.slice(0, 6) + '...');

  const res = await axios.post(
    'https://api.apollo.io/api/v1/mixed_people/api_search',
    { q_keywords: 'domain investor', per_page: 3 },
    { headers: { 'X-Api-Key': key!, 'Content-Type': 'application/json' } }
  );

  const person = res.data?.people?.[0];
  console.log('\nFirst person returned:');
  console.log(JSON.stringify(person, null, 2));
  console.log('\nTotal results:', res.data?.total_entries);
}

main().catch(e => {
  console.error('Error:', e.response?.status, JSON.stringify(e.response?.data));
});
