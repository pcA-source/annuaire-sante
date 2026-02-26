/**
 * Cloudflare Worker — Proxy API FHIR Annuaire Santé
 * Cache la clé API et reformate les données FHIR en JSON exploitable
 */

const API_BASE = 'https://gateway.api.esante.gouv.fr/fhir/v2';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/search') {
        return await handleSearch(url.searchParams, env);
      }
      if (path === '/api/practitioner' && url.searchParams.get('id')) {
        return await handlePractitionerDetail(url.searchParams.get('id'), env);
      }
      if (path === '/') {
        return new Response('Annuaire Santé Proxy OK', { status: 200, headers: CORS_HEADERS });
      }
      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

/**
 * Recherche de praticiens — multi-critères
 */
async function handleSearch(params, env) {
  const name = params.get('name') || '';
  const city = params.get('city') || '';
  const specialty = params.get('specialty') || '';
  const rpps = params.get('rpps') || '';
  const count = Math.min(parseInt(params.get('count') || '50', 10), 200);

  // Build FHIR search params
  const fhirParams = new URLSearchParams();
  fhirParams.set('_count', count.toString());

  if (rpps) {
    // Search by RPPS identifier
    fhirParams.set('identifier', `https://rpps.esante.gouv.fr|${rpps}`);
  } else {
    if (name) fhirParams.set('name', name);
  }

  // First search Practitioner
  const practitionerUrl = `${API_BASE}/Practitioner?${fhirParams.toString()}`;
  const bundle = await fhirFetch(practitionerUrl, env);

  if (!bundle.entry || bundle.entry.length === 0) {
    return jsonResponse({ total: 0, results: [] });
  }

  // Extract practitioner IDs to fetch their roles (which have address, specialty, etc.)
  const practitioners = bundle.entry.map(e => parsePractitioner(e.resource));
  const practitionerIds = practitioners.map(p => p.id);

  // Fetch PractitionerRoles for these practitioners (batched)
  const roles = await fetchRolesForPractitioners(practitionerIds, env, city, specialty);

  // Merge roles into practitioners
  const results = mergePractitionersAndRoles(practitioners, roles);

  // Filter by city/specialty if needed (post-filter for accuracy)
  let filtered = results;
  if (city) {
    const cityLower = city.toLowerCase();
    filtered = filtered.filter(r =>
      r.roles.some(role =>
        role.address?.toLowerCase().includes(cityLower) ||
        role.city?.toLowerCase().includes(cityLower) ||
        role.organization?.city?.toLowerCase().includes(cityLower) ||
        role.organization?.address?.toLowerCase().includes(cityLower)
      )
    );
  }
  if (specialty) {
    const specLower = specialty.toLowerCase();
    filtered = filtered.filter(r =>
      r.roles.some(role =>
        role.specialties?.some(s => s.toLowerCase().includes(specLower))
      )
    );
  }

  return jsonResponse({
    total: filtered.length,
    totalFhir: bundle.total || 0,
    results: filtered,
  });
}

/**
 * Détail d'un praticien par ID
 */
async function handlePractitionerDetail(id, env) {
  const practUrl = `${API_BASE}/Practitioner/${id}`;
  const resource = await fhirFetch(practUrl, env);
  const practitioner = parsePractitioner(resource);

  // Fetch roles
  const rolesUrl = `${API_BASE}/PractitionerRole?practitioner=${id}&_include=PractitionerRole:organization&_count=50`;
  const rolesBundle = await fhirFetch(rolesUrl, env);

  const roles = [];
  const orgs = {};

  if (rolesBundle.entry) {
    for (const entry of rolesBundle.entry) {
      if (entry.resource.resourceType === 'PractitionerRole') {
        roles.push(parsePractitionerRole(entry.resource));
      } else if (entry.resource.resourceType === 'Organization') {
        orgs[entry.resource.id] = parseOrganization(entry.resource);
      }
    }
  }

  // Attach org details to roles
  for (const role of roles) {
    if (role.organizationId && orgs[role.organizationId]) {
      role.organization = orgs[role.organizationId];
    }
  }

  practitioner.roles = roles;
  return jsonResponse(practitioner);
}

/**
 * Fetch PractitionerRoles for a list of practitioner IDs
 */
async function fetchRolesForPractitioners(ids, env, city, specialty) {
  if (ids.length === 0) return [];

  // FHIR allows comma-separated practitioner IDs
  const batchSize = 20;
  const allRoles = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const params = new URLSearchParams();
    params.set('practitioner', batch.join(','));
    params.set('_count', '200');
    params.set('_include', 'PractitionerRole:organization');

    const url = `${API_BASE}/PractitionerRole?${params.toString()}`;
    const bundle = await fhirFetch(url, env);

    if (bundle.entry) {
      for (const entry of bundle.entry) {
        if (entry.resource.resourceType === 'PractitionerRole') {
          allRoles.push(parsePractitionerRole(entry.resource));
        }
      }
    }
  }

  return allRoles;
}

/**
 * Merge practitioners and their roles
 */
function mergePractitionersAndRoles(practitioners, roles) {
  const rolesByPractitioner = {};
  for (const role of roles) {
    if (!role.practitionerId) continue;
    if (!rolesByPractitioner[role.practitionerId]) {
      rolesByPractitioner[role.practitionerId] = [];
    }
    rolesByPractitioner[role.practitionerId].push(role);
  }

  return practitioners.map(p => ({
    ...p,
    roles: rolesByPractitioner[p.id] || [],
  }));
}

// ─── FHIR Parsers ───

function parsePractitioner(resource) {
  const name = resource.name?.[0] || {};
  const identifiers = (resource.identifier || []).map(id => ({
    system: id.system,
    value: id.value,
    type: id.system?.includes('rpps') ? 'RPPS'
      : id.system?.includes('adeli') ? 'ADELI'
      : id.type?.coding?.[0]?.code || 'OTHER',
  }));

  const qualifications = (resource.qualification || []).map(q => ({
    code: q.code?.coding?.[0]?.code,
    display: q.code?.coding?.[0]?.display || q.code?.text,
    system: q.code?.coding?.[0]?.system,
  }));

  const rpps = identifiers.find(i => i.type === 'RPPS')?.value || null;

  return {
    id: resource.id,
    rpps,
    identifiers,
    lastName: name.family || '',
    firstName: (name.given || []).join(' '),
    prefix: (name.prefix || []).join(' '),
    suffix: (name.suffix || []).join(' '),
    qualifications,
    active: resource.active !== false,
  };
}

function parsePractitionerRole(resource) {
  const specialties = (resource.specialty || []).flatMap(s =>
    (s.coding || []).map(c => c.display || c.code)
  );

  const telecoms = (resource.telecom || []).map(t => ({
    system: t.system, // phone, email, fax
    value: t.value,
    use: t.use, // work, home, mobile
  }));

  // Address can be on the role itself or via location
  const addr = resource.extension?.find(e => e.url?.includes('address'))
    || resource.location?.[0]?.address || null;
  const address = addr ? formatAddress(addr) : null;

  // Extract practitioner reference ID
  const practRef = resource.practitioner?.reference || '';
  const practitionerId = practRef.replace('Practitioner/', '');

  // Extract organization reference ID
  const orgRef = resource.organization?.reference || '';
  const organizationId = orgRef.replace('Organization/', '');

  return {
    id: resource.id,
    practitionerId,
    organizationId,
    specialties,
    telecoms,
    address,
    city: addr?.city || null,
    postalCode: addr?.postalCode || null,
    active: resource.active !== false,
  };
}

function parseOrganization(resource) {
  const addr = resource.address?.[0] || null;
  const telecoms = (resource.telecom || []).map(t => ({
    system: t.system,
    value: t.value,
  }));

  return {
    id: resource.id,
    name: resource.name || '',
    type: resource.type?.[0]?.coding?.[0]?.display || '',
    address: addr ? formatAddress(addr) : null,
    city: addr?.city || null,
    postalCode: addr?.postalCode || null,
    telecoms,
  };
}

function formatAddress(addr) {
  if (!addr) return null;
  const parts = [
    ...(addr.line || []),
    [addr.postalCode, addr.city].filter(Boolean).join(' '),
    addr.country,
  ].filter(Boolean);
  return parts.join(', ');
}

// ─── Helpers ───

async function fhirFetch(url, env) {
  const apiKey = env.ESANTE_API_KEY || 'PLACEHOLDER_KEY';
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/fhir+json',
      'ESANTE-API-KEY': apiKey,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FHIR API ${res.status}: ${body.substring(0, 200)}`);
  }
  return res.json();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
